import {
  BBS, CHUNK_SIZE, HTML_PAGE_LIMIT, KEY, LATEST_COUNT, MAX_BODY_BYTES, MAX_POSTS,
} from "./config.js";
import {
  MESSAGES, PostError, escapeHtmlAttribute, getPosts, getThread, submitPost,
} from "./core.js";
import { decodeSjis } from "./sjis.js";

const BASE = `/test/read.cgi/${BBS}/${KEY}/`;
const BODY_TAG = "<body bgcolor=#efefef text=black link=blue alink=red vlink=#660099>";
const HEAD_META = '<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">';

function htmlResponse(html, status = 200, extraHeaders = {}) {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

export function errorPage(message, status) {
  return htmlResponse(
    `<html><head>${HEAD_META}<title>ＥＲＲＯＲ！</title></head>\n${BODY_TAG}\n` +
    `<b>ＥＲＲＯＲ：${escapeHtmlAttribute(message)}</b><hr>` +
    `<a href=${BASE}l${LATEST_COUNT}>戻る</a>\n</body></html>\n`,
    status
  );
}

function count(value) {
  return /^\d+$/.test(value ?? "") ? Number(value) : 0;
}

function parsePathRange(text) {
  const range = { st: 0, to: 0, ls: 0, nofirst: false };
  let match;
  if (text === "n") {
    range.nofirst = true;
  } else if ((match = /^l(\d+)$/.exec(text))) {
    range.ls = Number(match[1]);
  } else if ((match = /^(\d+)$/.exec(text))) {
    range.st = range.to = Number(match[1]);
    range.nofirst = true;
  } else if ((match = /^(\d*)-(\d*)$/.exec(text))) {
    range.st = Number(match[1] || 0);
    range.to = Number(match[2] || 0);
  }
  return range;
}

function parseQueryRange(query) {
  return {
    st: count(query.get("st")),
    to: count(query.get("to")),
    ls: count(query.get("ls")),
    nofirst: query.get("nofirst") === "true",
  };
}

function selectRange(lastNo, range) {
  let { nofirst } = range;
  let first;
  let last = lastNo;
  if (range.ls > 0) {
    if (range.ls === 1) {
      first = lastNo;
      nofirst = true;
    } else if (nofirst) {
      first = Math.max(1, lastNo - range.ls + 1);
    } else {
      first = Math.max(1, lastNo - range.ls + 2);
    }
  } else {
    first = Math.min(range.st > 0 ? range.st : 1, lastNo);
    last = Math.min(range.to > 0 ? range.to : lastNo, lastNo);
    if (first > last) last = first;
  }
  const prependFirst = first > 1 && !nofirst;

  let truncatedAt = null;
  const capacity = HTML_PAGE_LIMIT - (prependFirst ? 1 : 0);
  if (last - first + 1 > capacity) {
    last = first + capacity - 1;
    truncatedAt = last + 1;
  }
  return { first, last, prependFirst, truncatedAt };
}

function linkAnchors(messageHtml, lastNo) {
  return messageHtml.replace(/&gt;&gt;(\d+)(?:-(\d+))?/g, (whole, from, to) => {
    const n = Number(from);
    if (!(n >= 1 && n <= lastNo)) return whole;
    if (to === undefined) return `<a href="${BASE}${n}" target="_blank">${whole}</a>`;
    const m = Number(to);
    if (n > m) return whole;
    return `<a href="${BASE}${n}-${Math.min(m, lastNo)}" target="_blank">${whole}</a>`;
  });
}

function postHtml(row, lastNo) {
  const sage = /sage/i.test(row.mail);
  const color = sage ? "blue" : "green";
  let name = `<font color=${color}><b>${row.name} </b></font>`;
  if (!sage && row.mail !== "") name = `<a href="mailto:${row.mail}">${name}</a>`;
  const date = row.poster_id === "" ? row.date_text : `${row.date_text} ID:${row.poster_id}`;
  const message = linkAnchors(row.message.replaceAll("\n", " <br> "), lastNo);
  return `<dt>${row.no} 名前：${name}投稿日：${date}<dd> ${message} <br><br>\n`;
}

function navigation(lastNo, first, last) {
  const links = [
    '<a href="/' + BBS + '/">■掲示板に戻る■</a>',
    `<a href=${BASE}>レスを全部読む</a>`,
  ];
  for (let start = 1; start <= lastNo; start += CHUNK_SIZE) {
    links.push(`<a href=${BASE}${start}-${start + CHUNK_SIZE - 1}>${start}-</a>`);
  }
  if (first > 1 && last < lastNo) {
    links.push(`<a href=${BASE}${Math.max(1, first - CHUNK_SIZE)}-${first - 1}>前${CHUNK_SIZE}</a>`);
    links.push(`<a href=${BASE}${last + 1}-${Math.min(lastNo, last + CHUNK_SIZE)}>次${CHUNK_SIZE}</a>`);
  }
  links.push(`<a href=${BASE}l${LATEST_COUNT}>最新レス${LATEST_COUNT}</a>`);
  return links.join(" ");
}

function warningBand(lastNo) {
  let color;
  let text;
  if (lastNo >= MAX_POSTS) {
    color = "red";
    text = "レス数の上限に達したため書き込めません";
  } else if (lastNo * 100 > MAX_POSTS * 95) {
    color = "#ff6633";
    text = `まもなく書き込めなくなります(上限 ${MAX_POSTS} 件)`;
  } else if (lastNo * 100 > MAX_POSTS * 90) {
    color = "yellow";
    text = `レスが ${Math.floor(MAX_POSTS * 0.9)} 件を超えました(上限 ${MAX_POSTS} 件)`;
  } else {
    return "";
  }
  return `<table border=1 cellspacing=7 cellpadding=3 width=95% bgcolor=${color} align=center>` +
    `<tr><td>${text}</td></tr></table>\n`;
}

function formHtml(now) {
  return `<form method=POST action="/test/bbs.cgi"><input type=submit value="書き込む" name=submit> ` +
    `名前： <input name=FROM size=19> E-mail<font size=1> (省略可) </font>: <input name=mail size=19><br>` +
    `<textarea rows=5 cols=70 wrap=off name=MESSAGE></textarea>` +
    `<input type=hidden name=bbs value=${BBS}><input type=hidden name=key value=${KEY}>` +
    `<input type=hidden name=time value=${Math.floor(now / 1000)}></form>\n`;
}

export async function handleRead(env, params, now = Date.now()) {
  if (params.bbs !== BBS || params.key !== KEY) return errorPage(MESSAGES.noThread, 404);
  const thread = await getThread(env.simple_2ch_db);
  if (!thread) return errorPage(MESSAGES.noThread, 404);

  const lastNo = thread.lastNo;
  const range = params.rangeText ? parsePathRange(params.rangeText) : parseQueryRange(params.query);
  const { first, last, prependFirst, truncatedAt } = selectRange(lastNo, range);

  const rows = [];
  if (prependFirst) rows.push(...await getPosts(env.simple_2ch_db, 1, 1));
  rows.push(...await getPosts(env.simple_2ch_db, first, last));

  const full = lastNo >= MAX_POSTS;
  let html =
    `<html>\n<head>\n${HEAD_META}\n<title>${thread.title} </title>\n</head>\n${BODY_TAG}\n` +
    `${navigation(lastNo, first, last)}\n` +
    `<p><font size=+1 color=red>${thread.title} </font>\n<dl>\n`;
  for (const row of rows) html += postHtml(row, lastNo);
  html += "</dl>\n" + warningBand(lastNo);
  if (truncatedAt !== null) html += `<p><a href=${BASE}${truncatedAt}->続きを読む</a>\n`;
  html += "<hr>";
  if (!full) {
    if (last === lastNo) html += `<center><a href=${BASE}${lastNo}->新着レスの表示</a></center>`;
    html += "\n" + formHtml(now);
  } else {
    html += "\n";
  }
  html += "<p>\n</body></html>\n";
  return htmlResponse(html);
}

const STATUS = { invalid: 400, too_large: 413, rate: 429, full: 409, not_found: 404, config: 500 };

function sameHost(origin, url) {
  try {
    return new URL(origin).host === url.host;
  } catch {
    return false;
  }
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

function decodeField(bytes) {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return decodeSjis(bytes);
  }
}

function unescapeField(raw) {
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const byte = raw[i];
    if (byte === 0x2b) { // '+'
      out.push(0x20);
    } else if (byte === 0x25 && i + 2 < raw.length) { // '%'
      const hex = String.fromCharCode(raw[i + 1], raw[i + 2]);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        out.push(Number.parseInt(hex, 16));
        i += 2;
      } else {
        out.push(byte);
      }
    } else {
      out.push(byte);
    }
  }
  return new Uint8Array(out);
}

// フォームのバイト列を名前・値ともバイト列のまま取り出し、各値を
// UTF-8 として厳密に読めなければ Shift_JIS として読む(専用ブラウザ対策)。
function parseForm(bytes) {
  const fields = new Map();
  let start = 0;
  for (let i = 0; i <= bytes.length; i++) {
    if (i < bytes.length && bytes[i] !== 0x26) continue; // '&'
    const pair = bytes.subarray(start, i);
    start = i + 1;
    if (pair.length === 0) continue;
    const eq = pair.indexOf(0x3d); // '='
    const name = decodeField(unescapeField(eq < 0 ? pair : pair.subarray(0, eq)));
    if (fields.has(name)) continue;
    const value = eq < 0 ? new Uint8Array(0) : pair.subarray(eq + 1);
    fields.set(name, decodeField(unescapeField(value)));
  }
  return fields;
}

export async function handlePost(request, env, url, h, now = Date.now()) {
  const origin = request.headers.get("Origin");
  if (origin !== null && !sameHost(origin, url)) return errorPage("不正なリクエストです", 403);

  let bytes;
  try {
    bytes = await h.readBodyLimited(request, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof RangeError) return errorPage(MESSAGES.bodyTooLarge, 413);
    throw error;
  }
  const type = (request.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return errorPage("フォーム情報が不正です", 400);
  const form = parseForm(bytes);

  const bbs = (form.get("bbs") ?? "").replace(/[^A-Za-z0-9]/g, "");
  const key = (form.get("key") ?? "").replace(/\D/g, "");
  if (bbs !== BBS || key !== KEY) return errorPage(MESSAGES.noThread, 404);

  const digits = (form.get("time") ?? "").replace(/\D/g, "");
  const time = digits === "" ? 0 : Number(digits);
  if (time === 0) return errorPage("フォーム情報が不正です", 400);
  if (time >= Math.floor(now / 1000)) return errorPage("ブラウザを立ち上げなおしてみてください", 400);

  try {
    await submitPost(env, {
      name: form.get("FROM") ?? "",
      mail: form.get("mail") ?? "",
      message: form.get("MESSAGE") ?? "",
    }, { ip: h.clientIp(request), source: "web", now });
  } catch (error) {
    if (error instanceof PostError) return errorPage(error.message, STATUS[error.kind] ?? 400);
    throw error;
  }
  return new Response(null, {
    status: 303,
    headers: { Location: `${BASE}l${LATEST_COUNT}`, "Cache-Control": "no-store" },
  });
}
