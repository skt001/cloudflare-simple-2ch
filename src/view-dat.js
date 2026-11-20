import { BBS, FRESH_UPDATE_MS, KEY, RAW_MAX_KB } from "./config.js";
import { MESSAGES, getThread } from "./core.js";
import { concatBytes, encodeSjis } from "./sjis.js";

const SJIS_TYPE = "text/plain; charset=Shift_JIS";
const SYNC_ERROR = "どこかであぼーんがあったみたいです。";

function datLine(row, title) {
  const date = row.poster_id === "" ? row.date_text : `${row.date_text} ID:${row.poster_id}`;
  const message = row.message.replaceAll("\n", " <br> ");
  return `${row.name}<>${row.mail}<>${date}<> ${message} <>${row.no === 1 ? title : ""}\n`;
}

const STALE_SQL = `SELECT p.no, p.name, p.mail, p.date_text, p.poster_id, p.message
  FROM posts AS p LEFT JOIN dat_lines AS d ON d.no = p.no
  WHERE p.no BETWEEN ? AND ?
    AND (d.no IS NULL OR d.name <> p.name OR d.mail <> p.mail OR d.date_text <> p.date_text
      OR d.poster_id <> p.poster_id OR d.message <> p.message OR (p.no = 1 AND d.title <> ?))
  ORDER BY p.no`;

const UPSERT_SQL = `INSERT INTO dat_lines (no, line, bytes, name, mail, date_text, poster_id, message, title)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(no) DO UPDATE SET
    line = excluded.line, bytes = excluded.bytes, name = excluded.name, mail = excluded.mail,
    date_text = excluded.date_text, poster_id = excluded.poster_id, message = excluded.message,
    title = excluded.title`;

async function repairLines(db, title, lo, hi) {
  const { results } = await db.prepare(STALE_SQL).bind(lo, hi, title).all();
  if (!results.length) return;
  const statements = results.map((row) => {
    const bytes = encodeSjis(datLine(row, title));
    return db.prepare(UPSERT_SQL).bind(
      row.no, bytes, bytes.length, row.name, row.mail, row.date_text, row.poster_id, row.message,
      row.no === 1 ? title : "",
    );
  });
  for (let i = 0; i < statements.length; i += 100) {
    await db.batch(statements.slice(i, i + 100));
  }
}

async function datRangeBytes(db, title, lo, hi) {
  if (lo > hi) return new Uint8Array(0);
  await repairLines(db, title, lo, hi);
  const { results } = await db.prepare(
    "SELECT line FROM dat_lines WHERE no BETWEEN ? AND ? ORDER BY no",
  ).bind(lo, hi).all();
  return concatBytes(results.map((row) => (row.line instanceof Uint8Array ? row.line : new Uint8Array(row.line))));
}

function lastModified(thread) {
  return new Date(Math.floor(thread.modifiedAt / 1000) * 1000).toUTCString();
}

function isNotModified(request, thread, now) {
  const header = request.headers.get("If-Modified-Since");
  if (!header) return false;
  const since = Date.parse(header);
  if (Number.isNaN(since)) return false;
  if (now - thread.modifiedAt <= FRESH_UPDATE_MS) return false;
  return Math.floor(since / 1000) >= Math.floor(thread.modifiedAt / 1000);
}

function notModifiedResponse(thread) {
  return new Response(null, {
    status: 304,
    headers: { "Last-Modified": lastModified(thread), "Cache-Control": "no-cache" },
  });
}

function bodyResponse(bytes, thread, { status = 200, extra = {} } = {}) {
  return new Response(bytes, {
    status,
    headers: {
      "Content-Type": SJIS_TYPE,
      "Content-Length": String(bytes.length),
      "Last-Modified": lastModified(thread),
      "Cache-Control": "no-cache",
      ...extra,
    },
  });
}

function errResponse(message) {
  const bytes = encodeSjis(`-ERR ${message}\n`);
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": SJIS_TYPE,
      "Content-Length": String(bytes.length),
      "Cache-Control": "no-cache",
    },
  });
}

function count(value) {
  return /^\d+$/.test(value ?? "") ? Number(value) : 0;
}

function parseRawNumber(value) {
  return count(value.split(".")[0]);
}

function partialRange(last, { st, to, ls }) {
  if (ls === 1) return { first: last, last };
  let first = 1;
  let end = last;
  const start = ls > 1 ? last - ls + 1 : st;
  if (start > 0 && start <= last) first = start;
  if (to > 0 && to <= last) end = to;
  if (first > end) end = first;
  return { first, last: end };
}

export async function handleRaw(request, env, params, now = Date.now()) {
  if (params.bbs !== BBS || params.key !== KEY) return errResponse(MESSAGES.noThread);
  const thread = await getThread(env.DB);
  if (!thread) return errResponse(MESSAGES.noThread);
  if (isNotModified(request, thread, now)) return notModifiedResponse(thread);

  const n = parseRawNumber(params.raw);
  const last = thread.lastNo;
  const range = { st: count(params.st), to: count(params.to), ls: count(params.ls) };
  const maxText = `${RAW_MAX_KB}K`;

  let status;
  let body;
  if (n === 0 && (range.st > 0 || range.to > 0 || range.ls > 0)) {
    const { first, last: end } = partialRange(last, range);
    body = await datRangeBytes(env.DB, thread.title, first, end);
    status = (size) => `+PARTIAL ${size}/${maxText}\tRes:${first}-${end}/${last}`;
  } else if (n === 0) {
    body = await datRangeBytes(env.DB, thread.title, 1, last);
    status = (size) => `+OK ${size}/${maxText}`;
  } else if (n <= last) {
    body = await datRangeBytes(env.DB, thread.title, n + 1, last);
    status = (size) => `+OK ${size}/${maxText}`;
  } else {
    return errResponse(SYNC_ERROR);
  }

  return bodyResponse(concatBytes([encodeSjis(`${status(body.length)}\n`), body]), thread);
}

export async function handleDat(request, env, params, now = Date.now()) {
  if (params.bbs !== BBS || params.key !== KEY) return notFound();
  const thread = await getThread(env.DB);
  if (!thread) return notFound();
  if (isNotModified(request, thread, now)) return notModifiedResponse(thread);

  const bytes = await datRangeBytes(env.DB, thread.title, 1, thread.lastNo);
  const total = bytes.length;
  const common = { "Accept-Ranges": "bytes" };

  const match = /^bytes=(\d+)-$/i.exec((request.headers.get("Range") ?? "").trim());
  if (match) {
    const start = Number(match[1]);
    if (start >= total) {
      return new Response(null, {
        status: 416,
        headers: {
          ...common,
          "Content-Range": `bytes */${total}`,
          "Last-Modified": lastModified(thread),
          "Cache-Control": "no-cache",
        },
      });
    }
    return bodyResponse(bytes.slice(start), thread, {
      status: 206,
      extra: { ...common, "Content-Range": `bytes ${start}-${total - 1}/${total}` },
    });
  }
  return bodyResponse(bytes, thread, { extra: common });
}

export async function handleSubject(request, env, now = Date.now()) {
  const thread = await getThread(env.DB);
  if (!thread) return notFound();
  if (isNotModified(request, thread, now)) return notModifiedResponse(thread);
  const bytes = encodeSjis(`${KEY}.dat<>${thread.title} (${thread.lastNo})\n`);
  return bodyResponse(bytes, thread);
}

function notFound() {
  return new Response("Not Found\n", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=UTF-8", "Cache-Control": "no-store" },
  });
}
