import {
  API_LIMIT_DEFAULT, API_LIMIT_MAX, BBS, KEY, MAX_BODY_BYTES,
} from "./config.js";
import {
  MESSAGES, PostError, checkPost, getPost, getPosts, getThread, submitPost,
  toPublicPost, toPublicThread,
} from "./core.js";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const KINDS = {
  invalid: [400, "INVALID_REQUEST"],
  too_large: [413, "PAYLOAD_TOO_LARGE"],
  rate: [429, "RATE_LIMITED"],
  full: [409, "THREAD_FULL"],
  not_found: [404, "NOT_FOUND"],
  config: [500, "INTERNAL_ERROR"],
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function apiError(status, code, message) {
  return json({ error: { code, message } }, status);
}

function fromPostError(error) {
  const [status, code] = KINDS[error.kind] ?? [400, "INVALID_REQUEST"];
  return apiError(status, code, error.message);
}

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function integerParam(query, name, min) {
  const value = query.get(name);
  if (value === null) return undefined;
  if (!/^\d{1,15}$/.test(value) || Number(value) < min) {
    throw new ApiError(400, "INVALID_REQUEST", `${name} は ${min} 以上の整数で指定してください。`);
  }
  return Number(value);
}

async function digest(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

async function tokenMatches(expected, given) {
  const a = await digest(expected);
  const b = await digest(given);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function authorize(request, env) {
  if (!env.API_POST_TOKEN) {
    return apiError(503, "API_DISABLED", "投稿用の API は有効になっていません。");
  }
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("Authorization") ?? "");
  if (!match || !(await tokenMatches(env.API_POST_TOKEN, match[1].trim()))) {
    return apiError(401, "UNAUTHORIZED", "認証に失敗しました。");
  }
  return null;
}

async function readJsonBody(request, h) {
  let bytes;
  try {
    bytes = await h.readBodyLimited(request, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new ApiError(413, "PAYLOAD_TOO_LARGE", "リクエストが大きすぎます。");
    }
    throw error;
  }
  const type = (request.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") {
    throw new ApiError(400, "INVALID_REQUEST", "Content-Type は application/json にしてください。");
  }
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError(400, "INVALID_REQUEST", "JSON を解釈できません。");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "INVALID_REQUEST", "JSON オブジェクトで指定してください。");
  }
  for (const field of ["name", "mail"]) {
    if (body[field] !== undefined && typeof body[field] !== "string") {
      throw new ApiError(400, "INVALID_REQUEST", `${field} は文字列で指定してください。`);
    }
  }
  if (typeof body.message !== "string") {
    throw new ApiError(400, "INVALID_REQUEST", "message は文字列で指定してください。");
  }
  return { name: body.name ?? "", mail: body.mail ?? "", message: body.message };
}

async function listPosts(env, url) {
  const thread = await getThread(env.DB);
  if (!thread) throw new ApiError(404, "NOT_FOUND", MESSAGES.noThread);

  const q = url.searchParams;
  const from = integerParam(q, "from", 1);
  const to = integerParam(q, "to", 1);
  const last = integerParam(q, "last", 1);
  const after = integerParam(q, "after", 0);
  const limit = Math.min(integerParam(q, "limit", 1) ?? API_LIMIT_DEFAULT, API_LIMIT_MAX);
  if (last !== undefined && (from !== undefined || to !== undefined)) {
    throw new ApiError(400, "INVALID_REQUEST", "last は from・to と同時に指定できません。");
  }

  let lo = 1;
  let hi = thread.lastNo;
  if (last !== undefined) lo = Math.max(1, thread.lastNo - last + 1);
  if (from !== undefined) lo = Math.max(lo, from);
  if (to !== undefined) hi = Math.min(hi, to);
  if (after !== undefined) lo = Math.max(lo, after + 1);

  const rows = lo > hi ? [] : await getPosts(env.DB, lo, hi, limit + 1);
  const more = rows.length > limit;
  if (more) rows.pop();
  return json({
    thread: toPublicThread(thread, BBS, KEY),
    posts: rows.map(toPublicPost),
    next_cursor: more ? rows[rows.length - 1].no : null,
  });
}

export async function handleV1(request, env, url, h) {
  try {
    if (url.protocol !== "https:" && !LOCAL_HOSTS.has(url.hostname)) {
      return apiError(400, "INVALID_REQUEST", "HTTPS を使用してください。");
    }
    const method = request.method === "HEAD" ? "GET" : request.method;
    if (method === "POST") {
      const origin = request.headers.get("Origin");
      if (origin !== null && origin !== url.origin) {
        return apiError(403, "ORIGIN_FORBIDDEN", "別のオリジンからは書き込めません。");
      }
    }

    const path = url.pathname.slice("/api/v1".length).replace(/\/+$/, "");

    if (method === "GET" && path === "/thread") {
      const thread = await getThread(env.DB);
      if (!thread) return apiError(404, "NOT_FOUND", MESSAGES.noThread);
      return json({ thread: toPublicThread(thread, BBS, KEY) });
    }
    if (method === "GET" && path === "/posts") return await listPosts(env, url);

    const single = /^\/posts\/([^/]+)$/.exec(path);
    if (method === "GET" && single && single[1] !== "validate") {
      if (!/^\d{1,15}$/.test(single[1]) || Number(single[1]) < 1) {
        return apiError(400, "INVALID_REQUEST", "レス番号は 1 以上の整数で指定してください。");
      }
      const row = await getPost(env.DB, Number(single[1]));
      if (!row) return apiError(404, "POST_NOT_FOUND", "指定された番号のレスがありません。");
      return json({ post: toPublicPost(row) });
    }

    if (method === "POST" && (path === "/posts" || path === "/posts/validate")) {
      const denied = await authorize(request, env);
      if (denied) return denied;
      const input = await readJsonBody(request, h);
      const options = { ip: h.clientIp(request) };

      if (path === "/posts/validate") {
        const { normalized, remaining } = await checkPost(env, input, options);
        return json({ ok: true, normalized, remaining_posts: remaining });
      }
      const post = await submitPost(env, input, { ...options, source: "api" });
      const thread = await getThread(env.DB);
      return json({ post: toPublicPost(post), thread: toPublicThread(thread, BBS, KEY) }, 201);
    }

    return apiError(404, "NOT_FOUND", "指定された API はありません。");
  } catch (error) {
    if (error instanceof ApiError) return apiError(error.status, error.code, error.message);
    if (error instanceof PostError) return fromPostError(error);
    throw error;
  }
}
