import { BBS, KEY, MAX_PATH } from "./config.js";
import { handleV1 } from "./api-v1.js";
import { handleDat, handleRaw, handleSubject } from "./view-dat.js";
import { handlePost, handleRead } from "./view-html.js";

const READ_BASE = `/test/read.cgi/${BBS}/${KEY}/l50`;

function notFound() {
  return new Response("Not Found\n", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=UTF-8", "Cache-Control": "no-store" },
  });
}

async function readBodyLimited(request, limit) {
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > limit) throw new RangeError("Body too large");
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new RangeError("Body too large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

const helpers = { readBodyLimited, clientIp };

async function route(request, env, url) {
  const path = url.pathname;
  if (path.length >= MAX_PATH) return notFound();
  const method = request.method === "HEAD" ? "GET" : request.method;

  if (path === "/api/v1" || path.startsWith("/api/v1/")) {
    return await handleV1(request, env, url, helpers);
  }
  if (method === "POST") {
    return path === "/test/bbs.cgi" ? await handlePost(request, env, url, helpers) : notFound();
  }
  if (method !== "GET") return notFound();

  if (path === "/test/read.cgi" || path.startsWith("/test/read.cgi/")) {
    const segments = path.split("/").slice(3).filter((segment, i, all) => segment !== "" || i < all.length - 1);
    const query = url.searchParams;
    const fromPath = path !== "/test/read.cgi";
    const bbs = fromPath ? (segments[0] ?? "") : (query.get("bbs") ?? "");
    const key = fromPath ? (segments[1] ?? "") : (query.get("key") ?? "");
    if (segments.length > 3) return notFound();

    const raw = query.get("raw");
    if (raw !== null && raw !== "") {
      return await handleRaw(request, env, {
        bbs, key, raw, st: query.get("st"), to: query.get("to"), ls: query.get("ls"),
      });
    }
    return await handleRead(env, { bbs, key, rangeText: fromPath ? (segments[2] ?? "") : "", query });
  }

  if (path === `/${BBS}/subject.txt`) return await handleSubject(request, env);

  const dat = /^\/([^/]+)\/dat\/([^/]+)\.dat$/.exec(path);
  if (dat) return await handleDat(request, env, { bbs: dat[1], key: dat[2] });

  if (path === "/" || path === `/${BBS}/`) {
    return new Response(null, {
      status: 302,
      headers: { Location: READ_BASE, "Cache-Control": "no-store" },
    });
  }
  return notFound();
}

export default {
  async fetch(request, env) {
    try {
      const response = await route(request, env, new URL(request.url));
      if (request.method !== "HEAD") return response;
      return new Response(null, { status: response.status, headers: response.headers });
    } catch (error) {
      console.error(error);
      return new Response("サーバーでエラーが発生しました。\n", {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=UTF-8", "Cache-Control": "no-store" },
      });
    }
  },
};
