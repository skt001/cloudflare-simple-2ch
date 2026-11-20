import {
  DEFAULT_NAME, JST_OFFSET_MS, MAX_LINE, MAX_MAIL, MAX_MESSAGE, MAX_NAME,
  MAX_POSTS, RATE_LIMIT, RATE_WINDOW_MS,
} from "./config.js";

export class PostError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

export const MESSAGES = {
  noThread: "そんな板orスレッドないです。",
  noMessage: "本文がありません",
  nameLong: "名前が長すぎます",
  mailLong: "メールアドレスが長すぎます",
  messageLong: "本文が長すぎます",
  lineLong: "長すぎる行があります",
  bodyTooLarge: "文長杉",
  full: "レス数の上限に達したため書き込めません",
  notConfigured: "サーバーの設定が不完全です。",
};

const ESCAPES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"' };

export function escapeText(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeMail(text) {
  return escapeText(text).replaceAll('"', "&quot;");
}

export function unescapeText(text) {
  return text.replace(/&(?:amp|lt|gt|quot);/g, (entity) => ESCAPES[entity]);
}

export function escapeHtmlAttribute(text) {
  return escapeText(text).replaceAll('"', "&quot;");
}

function wellFormed(text) {
  return typeof text.toWellFormed === "function" ? text.toWellFormed() : text;
}

function length(text) {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

export function normalizeInput({ name = "", mail = "", message = "" }) {
  const clean = (value) => wellFormed(String(value))
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/\t/g, " ");

  let normalizedName = clean(name).replaceAll("\n", "").trim();
  const hash = normalizedName.indexOf("#");
  if (hash >= 0) normalizedName = normalizedName.slice(0, hash).trim();
  normalizedName = normalizedName.replaceAll("◆", "◇");
  if (normalizedName === "") normalizedName = DEFAULT_NAME;

  const normalizedMail = clean(mail).replaceAll("\n", "").trim();
  const normalizedMessage = clean(message).trim();

  if (length(normalizedName) > MAX_NAME) throw new PostError("invalid", MESSAGES.nameLong);
  if (length(normalizedMail) > MAX_MAIL) throw new PostError("invalid", MESSAGES.mailLong);
  if (normalizedMessage === "") throw new PostError("invalid", MESSAGES.noMessage);
  if (length(normalizedMessage) > MAX_MESSAGE) throw new PostError("invalid", MESSAGES.messageLong);
  const lines = normalizedMessage.split("\n");
  if (lines.some((line) => length(line) > MAX_LINE)) throw new PostError("invalid", MESSAGES.lineLong);

  return { name: normalizedName, mail: normalizedMail, message: normalizedMessage };
}

export function escapeForStorage({ name, mail, message }) {
  return { name: escapeText(name), mail: escapeMail(mail), message: escapeText(message) };
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

function jstParts(ms) {
  const date = new Date(ms + JST_OFFSET_MS);
  const two = (value) => String(value).padStart(2, "0");
  return {
    year: String(date.getUTCFullYear()).padStart(4, "0"),
    month: two(date.getUTCMonth() + 1),
    day: two(date.getUTCDate()),
    weekday: WEEKDAYS[date.getUTCDay()],
    hour: two(date.getUTCHours()),
    minute: two(date.getUTCMinutes()),
    second: two(date.getUTCSeconds()),
  };
}

export function formatJst(ms) {
  const p = jstParts(ms);
  return `${p.year}/${p.month}/${p.day}(${p.weekday}) ${p.hour}:${p.minute}:${p.second}`;
}

function jstDateKey(ms) {
  const p = jstParts(ms);
  return `${p.year}${p.month}${p.day}`;
}

export async function makePosterId(seed, ip, ms) {
  if (typeof seed !== "string" || seed === "") throw new PostError("config", MESSAGES.notConfigured);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(seed), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(`${ip}|${jstDateKey(ms)}`))
  );
  return btoa(String.fromCharCode(...signature)).slice(0, 8);
}

export async function getThread(db) {
  const row = await db.prepare(
    `SELECT t.title, t.created_at, t.modified_at,
            (SELECT COALESCE(MAX(no), 0) FROM posts) AS last_no
     FROM thread AS t WHERE t.id = 1`
  ).first();
  if (!row || row.last_no < 1) return null;
  return {
    title: row.title,
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
    lastNo: row.last_no,
  };
}

const POST_COLUMNS = "no, name, mail, date_text, poster_id, message, posted_at";

export async function getPosts(db, lo, hi, limit = Number.MAX_SAFE_INTEGER) {
  const result = await db.prepare(
    `SELECT ${POST_COLUMNS} FROM posts WHERE no BETWEEN ? AND ? ORDER BY no LIMIT ?`
  ).bind(lo, hi, limit).all();
  return result.results;
}

export async function getPost(db, no) {
  return await db.prepare(`SELECT ${POST_COLUMNS} FROM posts WHERE no = ?`).bind(no).first();
}

export function remainingPosts(thread) {
  return Math.max(0, MAX_POSTS - thread.lastNo);
}

export function toPublicPost(row) {
  return {
    no: row.no,
    name: unescapeText(row.name),
    mail: unescapeText(row.mail),
    date: row.date_text,
    id: row.poster_id,
    message: unescapeText(row.message),
    posted_at: row.posted_at,
  };
}

export function toPublicThread(thread, bbs, key) {
  return {
    id: key,
    bbs,
    title: unescapeText(thread.title),
    post_count: thread.lastNo,
    latest_post_no: thread.lastNo,
    max_posts: MAX_POSTS,
    full: thread.lastNo >= MAX_POSTS,
    updated_at: thread.modifiedAt,
  };
}

async function countRecent(db, posterId, now) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM posts WHERE poster_id = ? AND posted_at > ?`
  ).bind(posterId, now - RATE_WINDOW_MS).first();
  return row.n;
}

function rateError(count) {
  return new PostError("rate", `連続投稿ですか？？ ${count}回`);
}

async function validatePost(db, normalized, { posterId, now }) {
  const thread = await getThread(db);
  if (!thread) throw new PostError("not_found", MESSAGES.noThread);
  if (thread.lastNo >= MAX_POSTS) throw new PostError("full", MESSAGES.full);
  const count = await countRecent(db, posterId, now);
  if (count >= RATE_LIMIT) throw rateError(count);
  return { normalized, remaining: remainingPosts(thread) };
}

const INSERT_SQL =
  `INSERT INTO posts (no, name, mail, date_text, poster_id, message, posted_at, source)
   SELECT (SELECT COALESCE(MAX(no), 0) + 1 FROM posts), ?, ?, ?, ?, ?, ?, ?
   WHERE EXISTS (SELECT 1 FROM thread WHERE id = 1)
     AND EXISTS (SELECT 1 FROM posts)
     AND (SELECT COUNT(*) FROM posts WHERE poster_id = ? AND posted_at > ?) < ?
     AND (SELECT COALESCE(MAX(no), 0) FROM posts) < ?
   RETURNING no`;

const MAX_ATTEMPTS = 3;

async function savePost(db, normalized, { posterId, source, now }) {
  const stored = escapeForStorage(normalized);
  const dateText = formatJst(now);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let row;
    try {
      row = await db.prepare(INSERT_SQL).bind(
        stored.name, stored.mail, dateText, posterId, stored.message, now, source,
        posterId, now - RATE_WINDOW_MS, RATE_LIMIT, MAX_POSTS
      ).first();
    } catch (error) {
      if (attempt < MAX_ATTEMPTS && /UNIQUE constraint failed|PRIMARY KEY/i.test(String(error?.message))) continue;
      throw error;
    }
    if (row) {
      return {
        no: row.no, name: stored.name, mail: stored.mail, date_text: dateText,
        poster_id: posterId, message: stored.message, posted_at: now,
      };
    }

    const thread = await getThread(db);
    if (!thread) throw new PostError("not_found", MESSAGES.noThread);
    if (thread.lastNo >= MAX_POSTS) throw new PostError("full", MESSAGES.full);
    const count = await countRecent(db, posterId, now);
    if (count >= RATE_LIMIT) throw rateError(count);
  }
  throw new Error("Could not save the post");
}

export async function submitPost(env, input, { ip, source, now = Date.now() }) {
  const normalized = normalizeInput(input);
  const posterId = await makePosterId(env.ID_SEED, ip, now);
  return await savePost(env.DB, normalized, { posterId, source, now });
}

export async function checkPost(env, input, { ip, now = Date.now() }) {
  const normalized = normalizeInput(input);
  const posterId = await makePosterId(env.ID_SEED, ip, now);
  return await validatePost(env.DB, normalized, { posterId, now });
}
