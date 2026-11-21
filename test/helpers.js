import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.js";
import { BBS, KEY } from "../src/config.js";

// node:sqlite を D1 の API(prepare / bind / first / all / run)に見せる薄い層。
// D1 の SQL(単一文の INSERT…SELECT、トリガー)を、実際の SQLite で検証するために使う。
class Statement {
  constructor(sqlite, sql) {
    this.statement = sqlite.prepare(sql);
    this.params = [];
  }
  bind(...params) {
    this.params = params;
    return this;
  }
  async first() {
    return this.statement.get(...this.params) ?? null;
  }
  async all() {
    return { results: this.statement.all(...this.params).map((row) => ({ ...row })) };
  }
  async run() {
    const result = this.statement.run(...this.params);
    return { meta: { changes: Number(result.changes) } };
  }
}

export class FakeD1 {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    const dir = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(dir).sort()) {
      if (name.endsWith(".sql")) this.sqlite.exec(readFileSync(new URL(name, dir), "utf8"));
    }
  }
  prepare(sql) {
    return new Statement(this.sqlite, sql);
  }
  async batch(statements) {
    this.sqlite.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  exec(sql) {
    this.sqlite.exec(sql);
  }
}

export const ORIGIN = "https://bbs.example.test";

export function makeEnv(overrides = {}) {
  return { simple_2ch_db: new FakeD1(), ID_SEED: "test-seed", API_POST_TOKEN: "test-token", ...overrides };
}

const SAMPLE_DAT = `名無しさん<><>2026/11/18(水) 09:00:01 ID:Ab3dEf9G<> テスト用スレッドです。ダミーデータなので自由に眺めてください。 <>サンプルスレッド
名無しさん<>sage<>2026/11/18(水) 09:01:12 ID:Hj7kLm2N<> 2get <br> 改行も確認できます。 <>
テスト太郎<>sage<>2026/11/18(水) 09:03:45 ID:Pq4rSt6U<> &gt;&gt;1 <br> スレ立て乙です。 <>
名無しさん<><>2026/11/18(水) 09:05:20 ID:Vw8xYz1A<> &gt;&gt;2-3 <br> まとめてアンカーのテストです。 <>
名無しさん<>sage<>2026/11/18(水) 09:10:00 ID:Bc5dEf2G<> 山括弧のエスケープ確認: &lt;b&gt;太字ではありません&lt;/b&gt; <>
名無しさん<><>2026/11/18(水) 10:15:33 ID:Hi6jKl3M<> 絵文字は &#128512; のように数値文字参照になります。 <>
名前欄あり ◆TestTrip<>sage<>2026/11/18(水) 11:20:48 ID:No7pQr4S<> 名前欄にトリップ風の表示がある例です。 <>
名無しさん<><>2026/11/18(水) 12:00:00 ID:Tu8vWx5Y<> 長い行の折り返し確認: あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん <>
名無しさん<>sage<>2026/11/18(水) 13:30:12 ID:Za9bCd6E<> &gt;&gt;5 <br> sage なので名前が太字にならない表示の確認です。 <>
名無しさん<><>2026/11/18(水) 14:45:59 ID:Fg1hIj7K<> 最新レスのサンプルです。 <>`;

export function sampleLines() {
  return SAMPLE_DAT.split("\n").filter((line) => line !== "");
}

export function seedSample(env) {
  const lines = sampleLines();
  const title = lines[0].split("<>")[4];
  env.simple_2ch_db.exec(`INSERT INTO thread (id, title, created_at, modified_at) VALUES (1, '${title}', 0, 0)`);
  const insert = env.simple_2ch_db.sqlite.prepare(
    "INSERT INTO posts (no, name, mail, date_text, poster_id, message, posted_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'web')"
  );
  lines.forEach((line, index) => {
    const [name, mail, dateId, body] = line.split("<>");
    const [, date, id] = /^(.*) ID:(.*)$/.exec(dateId);
    const message = body.slice(1, -1).replaceAll(" <br> ", "\n").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
    insert.run(index + 1, name, mail, date, id, message, 1_700_000_000_000 + index);
  });
  env.simple_2ch_db.exec("UPDATE thread SET modified_at = 1700000000000 WHERE id = 1");
}

// 1 番だけのスレッド(以降の番号は投稿で作る)
export function seedMinimal(env, message = "最初のレス") {
  env.simple_2ch_db.exec("INSERT INTO thread (id, title, created_at, modified_at) VALUES (1, 'テストスレ', 0, 0)");
  env.simple_2ch_db.sqlite.prepare(
    "INSERT INTO posts (no, name, mail, date_text, poster_id, message, posted_at, source) VALUES (1, '名無しさん', '', '2026/11/18(水) 09:00:00', 'Seed0001', ?, 0, 'web')"
  ).run(message);
  env.simple_2ch_db.exec("UPDATE thread SET modified_at = 1700000000000 WHERE id = 1");
}

// 番号 from〜to を埋める(レス数の境界の検証用)
export function fillPosts(env, from, to) {
  env.simple_2ch_db.sqlite.prepare(
    `WITH RECURSIVE s(n) AS (SELECT ? UNION ALL SELECT n + 1 FROM s WHERE n < ?)
     INSERT INTO posts (no, name, mail, date_text, poster_id, message, posted_at, source)
     SELECT n, '名無しさん', '', '2026/11/18(水) 09:00:00', 'Fill0001', 'x', 0, 'web' FROM s`
  ).run(from, to);
}

export function setModified(env, ms) {
  env.simple_2ch_db.sqlite.prepare("UPDATE thread SET modified_at = ? WHERE id = 1").run(ms);
}

export const readBase = `/test/read.cgi/${BBS}/${KEY}`;

export async function call(env, path, { method = "GET", headers = {}, body } = {}) {
  return await worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body }), env);
}

export async function bytesOf(response) {
  return new Uint8Array(await response.arrayBuffer());
}

export function decodeSjis(bytes) {
  return new TextDecoder("shift_jis").decode(bytes);
}

export function form(fields) {
  return new URLSearchParams(fields).toString();
}

// 通常ブラウザの投稿。time は現在より前にしておく。
export async function postForm(env, fields, headers = {}) {
  return await call(env, "/test/bbs.cgi", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: form({
      bbs: BBS, key: KEY, time: String(Math.floor(Date.now() / 1000) - 30), submit: "書き込む", ...fields,
    }),
  });
}

export async function apiCall(env, path, { method = "GET", token = "test-token", body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (token !== null) init.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return await call(env, `/api/v1${path}`, init);
}
