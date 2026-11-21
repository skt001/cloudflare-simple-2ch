import assert from "node:assert/strict";
import test from "node:test";
import { FakeD1, makeEnv, seedMinimal, seedSample, call, postForm } from "./helpers.js";

// D1 に流す SQL(migrations)を、実際の SQLite で検証する。

function modifiedAt(db) {
  return db.sqlite.prepare("SELECT modified_at AS m FROM thread WHERE id = 1").get().m;
}

test("トリガー: 行の追加で thread.modified_at が現在時刻(ミリ秒)になる", () => {
  const db = new FakeD1();
  db.exec("INSERT INTO thread VALUES (1, 't', 0, 0)");
  const before = Date.now();
  db.exec("INSERT INTO posts VALUES (1, 'n', '', 'd', 'i', 'm', 0, 'web')");
  const after = Date.now();
  const value = modifiedAt(db);
  assert.ok(value >= before - 1000 && value <= after + 1000, `modified_at=${value}`);
  assert.notEqual(value % 1000, 0, "ミリ秒の精度で書かれている(確率的に 1/1000 を除く)") ;
});

test("トリガー: 単一行・範囲の UPDATE(あぼーん)でも更新される", () => {
  const env = makeEnv();
  seedSample(env);
  const { db = env.simple_2ch_db } = {};
  assert.equal(modifiedAt(db), 1700000000000);

  db.exec("UPDATE posts SET name = 'あぼーん', mail = '', date_text = 'あぼーん', poster_id = '', message = 'あぼーん' WHERE no = 4");
  const single = modifiedAt(db);
  assert.ok(single > 1700000000000);

  db.exec("UPDATE thread SET modified_at = 1700000000000 WHERE id = 1");
  db.exec("UPDATE posts SET message = 'あぼーん' WHERE no BETWEEN 3 AND 6");
  assert.ok(modifiedAt(db) > 1700000000000);
});

test("トリガー: 該当行のない UPDATE では更新されない", () => {
  const env = makeEnv();
  seedSample(env);
  env.simple_2ch_db.exec("UPDATE posts SET message = 'x' WHERE no = 999");
  assert.equal(modifiedAt(env.simple_2ch_db), 1700000000000);
});

test("thread は 1 行だけ(id = 1 の制約)", () => {
  const db = new FakeD1();
  db.exec("INSERT INTO thread VALUES (1, 't', 0, 0)");
  assert.throws(() => db.exec("INSERT INTO thread VALUES (2, 't', 0, 0)"));
  assert.throws(() => db.exec("INSERT INTO thread VALUES (1, 't', 0, 0)"));
});

test("posts: NULL・不正な source・同じ番号の二重登録は失敗する", () => {
  const db = new FakeD1();
  db.exec("INSERT INTO posts VALUES (1, 'n', '', 'd', 'i', 'm', 0, 'web')");
  assert.throws(() => db.exec("INSERT INTO posts VALUES (1, 'n', '', 'd', 'i', 'm', 0, 'web')"));
  assert.throws(() => db.exec("INSERT INTO posts VALUES (2, 'n', '', 'd', 'i', 'm', 0, 'other')"));
  assert.throws(() => db.exec("INSERT INTO posts VALUES (3, NULL, '', 'd', 'i', 'm', 0, 'web')"));
});

test("投稿の INSERT…SELECT: スレッドが初期化されていなければ 1 件も挿入されない", async () => {
  const env = makeEnv();
  const response = await postForm(env, { FROM: "a", mail: "", MESSAGE: "hello" });
  assert.equal(response.status, 404);
  assert.equal(env.simple_2ch_db.sqlite.prepare("SELECT COUNT(*) AS n FROM posts").get().n, 0);

  env.simple_2ch_db.exec("INSERT INTO thread VALUES (1, 't', 0, 0)"); // thread だけで 1 番がない
  const second = await postForm(env, { FROM: "a", mail: "", MESSAGE: "hello" });
  assert.equal(second.status, 404);
  assert.equal(env.simple_2ch_db.sqlite.prepare("SELECT COUNT(*) AS n FROM posts").get().n, 0);
});

test("投稿: 番号は 1 つずつ増え、thread.modified_at が更新される", async () => {
  const env = makeEnv();
  seedMinimal(env);
  for (let i = 0; i < 3; i++) {
    const response = await postForm(env, { FROM: "a", mail: "", MESSAGE: `m${i}` }, { "CF-Connecting-IP": `192.0.2.${i}` });
    assert.equal(response.status, 303);
  }
  const numbers = env.simple_2ch_db.sqlite.prepare("SELECT no FROM posts ORDER BY no").all().map((row) => row.no);
  assert.deepEqual(numbers, [1, 2, 3, 4]);
  assert.ok(modifiedAt(env.simple_2ch_db) > 1700000000000);
});

test("同時投稿でも番号が連続し、重複しない", async () => {
  const env = makeEnv();
  seedMinimal(env);
  const responses = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      postForm(env, { FROM: `n${i}`, mail: "", MESSAGE: `m${i}` }, { "CF-Connecting-IP": `198.51.100.${i}` }))
  );
  assert.ok(responses.every((response) => response.status === 303));
  const numbers = env.simple_2ch_db.sqlite.prepare("SELECT no FROM posts ORDER BY no").all().map((row) => row.no);
  assert.deepEqual(numbers, Array.from({ length: 21 }, (_, i) => i + 1));
});

test("未知のパスは 404", async () => {
  const env = makeEnv();
  const response = await call(env, "/nothing");
  assert.equal(response.status, 404);
});

test("batch: 途中の文が失敗すると、全体がロールバックされる", async () => {
  const env = makeEnv();
  const insert = (no) => env.simple_2ch_db.prepare(
    "INSERT INTO dat_lines (no, line, bytes, name, mail, date_text, poster_id, message, title) VALUES (?, ?, 0, '', '', '', '', '', '')",
  ).bind(no, new Uint8Array([0x0a]));
  await assert.rejects(env.simple_2ch_db.batch([insert(1), insert(1)]));
  assert.equal(env.simple_2ch_db.sqlite.prepare("SELECT COUNT(*) AS n FROM dat_lines").get().n, 0);
  await env.simple_2ch_db.batch([insert(1), insert(2)]);
  assert.equal(env.simple_2ch_db.sqlite.prepare("SELECT COUNT(*) AS n FROM dat_lines").get().n, 2);
});
