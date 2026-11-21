import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { bytesOf, call, decodeSjis, makeEnv, readBase, seedSample } from "./helpers.js";

// ADMIN.md の SQL 雛形が、そのまま実行できて、意図どおりに動くことを確認する。

const ADMIN = readFileSync(new URL("../ADMIN.md", import.meta.url), "utf8");

function template(name) {
  const match = new RegExp("```sql\\n-- \\[template:" + name + "\\]\\n([\\s\\S]*?)```").exec(ADMIN);
  assert.ok(match, `ADMIN.md に雛形 ${name} がない`);
  return match[1];
}

test("初期スレッドの雛形: 実行すると、スレッドと 1 番ができて、HTML・dat・JSON で読める", async () => {
  const env = makeEnv();
  assert.equal((await call(env, `${readBase}/`)).status, 404, "初期化前は「そんな板orスレッドないです。」");

  env.simple_2ch_db.exec(template("init"));
  const dat = decodeSjis(await bytesOf(await call(env, "/simple/dat/1795000000.dat")));
  assert.equal(dat, "名無しさん<><>2026/11/19(木) 12:00:00 ID:Admin001<> 最初のレスの本文です。 <>スレッドのタイトル\n");

  const page = await (await call(env, `${readBase}/`)).text();
  assert.ok(page.includes("<title>スレッドのタイトル </title>"));
  const api = await (await call(env, "/api/v1/thread")).json();
  assert.equal(api.thread.post_count, 1);
  const modified = env.simple_2ch_db.sqlite.prepare("SELECT modified_at FROM thread WHERE id = 1").get().modified_at;
  assert.ok(Math.abs(modified - Date.now()) < 5000, "最終更新は現在時刻(ミリ秒)");
  assert.ok((await call(env, "/api/v1/posts")).ok);
});

test("あぼーんの雛形: SELECT で対象を確認でき、UPDATE で値が書き換わり、最終更新が進む", async () => {
  const env = makeEnv();
  seedSample(env);
  const before = env.simple_2ch_db.sqlite.prepare(template("select-before-abon")).all();
  assert.equal(before.length, 1);
  assert.equal(before[0].no, 5);

  env.simple_2ch_db.exec(template("abon"));
  const row = env.simple_2ch_db.sqlite.prepare("SELECT name, mail, date_text, poster_id, message FROM posts WHERE no = 5").get();
  assert.deepEqual({ ...row }, { name: "あぼーん", mail: "", date_text: "あぼーん", poster_id: "", message: "あぼーん" });
  assert.ok(env.simple_2ch_db.sqlite.prepare("SELECT modified_at FROM thread").get().modified_at > 1700000000000);

  const dat = decodeSjis(await bytesOf(await call(env, "/simple/dat/1795000000.dat")));
  assert.ok(dat.split("\n")[4] === "あぼーん<><>あぼーん<> あぼーん <>");
});

test("あぼーんの雛形の WHERE は、1 番(スレッドタイトルの行)を対象にしない", () => {
  const env = makeEnv();
  seedSample(env);
  const sql = template("abon").replace("(no = 5)", "(no = 1)");
  assert.notEqual(sql, template("abon"));
  env.simple_2ch_db.exec(sql);
  const first = env.simple_2ch_db.sqlite.prepare("SELECT name, message FROM posts WHERE no = 1").get();
  assert.equal(first.name, "名無しさん");
  assert.notEqual(first.message, "あぼーん");
});

test("あぼーんの雛形(範囲・ID 指定の書き換え例)も実行できる", () => {
  const env = makeEnv();
  seedSample(env);
  const range = template("abon").replace("(no = 5)", "(no BETWEEN 3 AND 6)");
  env.simple_2ch_db.exec(range);
  const changed = env.simple_2ch_db.sqlite.prepare("SELECT COUNT(*) AS n FROM posts WHERE message = 'あぼーん'").get().n;
  assert.equal(changed, 4);
});
