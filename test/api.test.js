import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import worker from "../src/index.js";
import { ORIGIN, apiCall, fillPosts, makeEnv, seedMinimal, seedSample } from "./helpers.js";

afterEach(() => mock.restoreAll());

function sampleEnv(overrides) {
  const env = makeEnv(overrides);
  seedSample(env);
  return env;
}

async function json(response) {
  return await response.json();
}

function assertError(body, code) {
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.equal(body.error.code, code);
  assert.equal(typeof body.error.message, "string");
}

let ipCounter = 0;
const ip = () => ({ "CF-Connecting-IP": `203.0.113.${++ipCounter % 250}` });

// ---------- 読み取り(認証なし) ----------

test("GET /thread: スレッド情報(認証なしで読める)", async () => {
  const env = sampleEnv();
  const response = await apiCall(env, "/thread", { token: null });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.match(response.headers.get("Content-Type"), /^application\/json/);
  assert.deepEqual(await json(response), {
    thread: {
      id: "1795000000", bbs: "simple", title: "サンプルスレッド", post_count: 10, latest_post_no: 10,
      max_posts: 5000, full: false, updated_at: 1700000000000,
    },
  });
});

test("GET /thread: レス数の上限に達していれば full が true", async () => {
  const env = sampleEnv();
  fillPosts(env, 11, 5000);
  const { thread } = await json(await apiCall(env, "/thread", { token: null }));
  assert.deepEqual([thread.post_count, thread.full], [5000, true]);
});

test("GET /posts: 既定は昇順で全件(100 件まで)、スキーマは no/name/mail/date/id/message/posted_at", async () => {
  const env = sampleEnv();
  const body = await json(await apiCall(env, "/posts", { token: null }));
  assert.equal(body.posts.length, 10);
  assert.equal(body.next_cursor, null);
  assert.equal(body.thread.latest_post_no, 10);
  assert.deepEqual(body.posts[1], {
    no: 2, name: "名無しさん", mail: "sage", date: "2026/11/18(水) 09:01:12", id: "Hj7kLm2N",
    message: "2get\n改行も確認できます。", posted_at: 1700000000001,
  });
  assert.deepEqual(body.posts.map((post) => post.no), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("GET /posts: エスケープを元に戻したプレーンテキストで返す(HTML・dat の形式に依存しない)", async () => {
  const env = sampleEnv();
  const body = await json(await apiCall(env, "/posts?from=5&to=6", { token: null }));
  assert.equal(body.posts[0].message, "山括弧のエスケープ確認: <b>太字ではありません</b>");
  assert.equal(body.posts[1].message, "絵文字は 😀 のように数値文字参照になります。");
  const anchors = await json(await apiCall(env, "/posts?from=3&to=4", { token: null }));
  assert.equal(anchors.posts[0].message, ">>1\nスレ立て乙です。");

  env.simple_2ch_db.exec(`INSERT INTO posts VALUES (11, '&lt;名&amp;前&gt;', '&quot;m&quot;', 'd', 'i', 'a &amp;lt; &amp; &lt;b&gt;', 0, 'web')`);
  const { post } = await json(await apiCall(env, "/posts/11", { token: null }));
  assert.deepEqual([post.name, post.mail, post.message], ["<名&前>", '"m"', "a &lt; & <b>"]);
  env.simple_2ch_db.exec("UPDATE thread SET title = 'a &amp; &lt;b&gt;' WHERE id = 1");
  const { thread } = await json(await apiCall(env, "/thread", { token: null }));
  assert.equal(thread.title, "a & <b>");
});

test("GET /posts: from / to / last / after / limit とページング(next_cursor)", async () => {
  const env = sampleEnv();
  const nos = async (query) => (await json(await apiCall(env, `/posts?${query}`, { token: null }))).posts.map((post) => post.no);
  assert.deepEqual(await nos("from=3&to=5"), [3, 4, 5]);
  assert.deepEqual(await nos("from=8"), [8, 9, 10]);
  assert.deepEqual(await nos("to=2"), [1, 2]);
  assert.deepEqual(await nos("last=3"), [8, 9, 10]);
  assert.deepEqual(await nos("last=99"), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(await nos("after=7"), [8, 9, 10]);
  assert.deepEqual(await nos("after=10"), []);
  assert.deepEqual(await nos("from=9&to=3"), []);
  assert.deepEqual(await nos("limit=2"), [1, 2]);

  // 巡回: after=next_cursor で続けて取得できる
  const seen = [];
  let cursor = null;
  do {
    const body = await json(await apiCall(env, `/posts?limit=3${cursor === null ? "" : `&after=${cursor}`}`, { token: null }));
    seen.push(...body.posts.map((post) => post.no));
    cursor = body.next_cursor;
  } while (cursor !== null);
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const first = await json(await apiCall(env, "/posts?limit=3", { token: null }));
  assert.equal(first.next_cursor, 3);
  const exact = await json(await apiCall(env, "/posts?limit=10", { token: null }));
  assert.equal(exact.next_cursor, null);
});

test("GET /posts: 1000 件を超えるスレでも limit ごとに続けて取得でき、limit は 500 まで", async () => {
  const env = sampleEnv();
  fillPosts(env, 11, 1200);
  const all = await json(await apiCall(env, "/posts?limit=9999", { token: null }));
  assert.equal(all.posts.length, 500);
  assert.equal(all.next_cursor, 500);
  const seen = [];
  let cursor = 0;
  while (cursor !== null) {
    const body = await json(await apiCall(env, `/posts?after=${cursor}&limit=500`, { token: null }));
    seen.push(...body.posts.map((post) => post.no));
    cursor = body.next_cursor;
  }
  assert.equal(seen.length, 1200);
  assert.deepEqual([seen[0], seen[1199]], [1, 1200]);
  const defaults = await json(await apiCall(env, "/posts", { token: null }));
  assert.equal(defaults.posts.length, 100);
  assert.equal(defaults.next_cursor, 100);
});

test("GET /posts: 不正なパラメータは 400 INVALID_REQUEST", async () => {
  const env = sampleEnv();
  for (const query of ["from=0", "from=abc", "to=-1", "last=0", "limit=0", "after=-1", "last=3&from=2", "last=3&to=5", "limit=1.5"]) {
    const response = await apiCall(env, `/posts?${query}`, { token: null });
    assert.equal(response.status, 400, query);
    assertError(await json(response), "INVALID_REQUEST");
  }
});

test("GET /posts/{no}: 単一投稿。ないときは 404 POST_NOT_FOUND、不正な番号は 400", async () => {
  const env = sampleEnv();
  const ok = await apiCall(env, "/posts/3", { token: null });
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys((await json(ok)).post), ["no", "name", "mail", "date", "id", "message", "posted_at"]);
  const missing = await apiCall(env, "/posts/99", { token: null });
  assert.equal(missing.status, 404);
  assertError(await json(missing), "POST_NOT_FOUND");
  for (const no of ["0", "abc", "-1"]) assert.equal((await apiCall(env, `/posts/${no}`, { token: null })).status, 400, no);
});

test("あぼーんした行は、書き換え後の値をそのまま返す(id は空)", async () => {
  const env = sampleEnv();
  env.simple_2ch_db.exec("UPDATE posts SET name = 'あぼーん', mail = '', date_text = 'あぼーん', poster_id = '', message = 'あぼーん' WHERE no = 4");
  const { post } = await json(await apiCall(env, "/posts/4", { token: null }));
  assert.deepEqual([post.name, post.mail, post.date, post.id, post.message], ["あぼーん", "", "あぼーん", "", "あぼーん"]);
  const { thread } = await json(await apiCall(env, "/thread", { token: null }));
  assert.ok(thread.updated_at > 1700000000000, "あぼーんで updated_at が更新される");
});

test("スレッドがないときは 404 NOT_FOUND。未知のパスも 404", async () => {
  const empty = makeEnv();
  for (const path of ["/thread", "/posts"]) {
    const response = await apiCall(empty, path, { token: null });
    assert.equal(response.status, 404);
    assertError(await json(response), "NOT_FOUND");
  }
  const unknown = await apiCall(sampleEnv(), "/nothing", { token: null });
  assert.equal(unknown.status, 404);
  assertError(await json(unknown), "NOT_FOUND");
});

// ---------- 認証なし ----------

test("投稿系は認証なしで使える(トークン不要)", async () => {
  const env = sampleEnv();
  const validate = await apiCall(env, "/posts/validate", { method: "POST", headers: ip(), body: { message: "a" } });
  assert.equal(validate.status, 200);
  const posted = await apiCall(env, "/posts", { method: "POST", headers: ip(), body: { message: "a" } });
  assert.equal(posted.status, 201);
  assert.equal(env.simple_2ch_db.sqlite.prepare("SELECT COUNT(*) AS n FROM posts").get().n, 11);
});

// ---------- 投稿前検証・投稿 ----------

test("POST /posts/validate: 正規化後の値と残りレス数を返し、保存せず、連続投稿規制の件数も増やさない", async () => {
  const env = sampleEnv();
  const headers = ip();
  for (let i = 0; i < 10; i++) {
    const response = await apiCall(env, "/posts/validate", { method: "POST", headers, body: { name: " 太郎#abc◆", mail: "sage ", message: "\r\n本文\r\n2行目 " } });
    assert.equal(response.status, 200);
    assert.deepEqual(await json(response), {
      ok: true, normalized: { name: "太郎", mail: "sage", message: "本文\n2行目" }, remaining_posts: 4990,
    });
  }
  assert.equal(env.simple_2ch_db.sqlite.prepare("SELECT COUNT(*) AS n FROM posts").get().n, 10);
  const post = await apiCall(env, "/posts", { method: "POST", headers, body: { message: "x" } });
  assert.equal(post.status, 201, "validate を繰り返しても規制にならない");
});

test("POST /posts/validate: name・mail は省略可(名前は既定名)。検証エラーは 400 INVALID_REQUEST", async () => {
  const env = sampleEnv();
  const ok = await json(await apiCall(env, "/posts/validate", { method: "POST", headers: ip(), body: { message: "a" } }));
  assert.deepEqual(ok.normalized, { name: "名無しさん", mail: "", message: "a" });
  const bad = await apiCall(env, "/posts/validate", { method: "POST", headers: ip(), body: { message: "  " } });
  assert.equal(bad.status, 400);
  const body = await json(bad);
  assertError(body, "INVALID_REQUEST");
  assert.equal(body.error.message, "本文がありません");
});

test("POST /posts: 201 と、保存した投稿(post)と thread。source は api。time は使わない", async () => {
  const now = Date.UTC(2026, 10, 19, 15, 30, 45);
  mock.method(Date, "now", () => now);
  const env = sampleEnv();
  const response = await apiCall(env, "/posts", {
    method: "POST", headers: { "CF-Connecting-IP": "192.0.2.77" },
    body: { name: "AI <bot>", mail: 'a"b', message: "こんにちは & <b>\n>>1" },
  });
  assert.equal(response.status, 201);
  const body = await json(response);
  assert.deepEqual(Object.keys(body), ["post", "thread"]);
  assert.equal(body.post.no, 11);
  assert.equal(body.post.name, "AI <bot>");
  assert.equal(body.post.mail, 'a"b');
  assert.equal(body.post.message, "こんにちは & <b>\n>>1");
  assert.equal(body.post.date, "2026/11/20(金) 00:30:45");
  assert.match(body.post.id, /^[A-Za-z0-9+/]{8}$/);
  assert.equal(body.post.posted_at, now);
  assert.equal(body.thread.latest_post_no, 11);
  assert.equal(body.thread.post_count, 11);

  const saved = env.simple_2ch_db.sqlite.prepare("SELECT name, mail, message, source FROM posts WHERE no = 11").get();
  assert.deepEqual({ ...saved }, { name: "AI &lt;bot&gt;", mail: "a&quot;b", message: "こんにちは &amp; &lt;b&gt;\n&gt;&gt;1", source: "api" });
  const list = await json(await apiCall(env, "/posts?last=1", { token: null }));
  assert.equal(list.posts[0].message, "こんにちは & <b>\n>>1");
});

test("POST /posts: 制限値・正規化は HTML と同じ(同じメッセージ)", async () => {
  const env = sampleEnv();
  const cases = [
    [{ message: "a", name: "あ".repeat(65) }, "名前が長すぎます"],
    [{ message: "a", mail: "a".repeat(65) }, "メールアドレスが長すぎます"],
    [{ message: "あ".repeat(1025) }, "長すぎる行があります"],
    [{ message: ("あ".repeat(1000) + "\n").repeat(4) + "あ".repeat(100) }, "本文が長すぎます"],
  ];
  for (const [body, message] of cases) {
    const response = await apiCall(env, "/posts", { method: "POST", headers: ip(), body });
    assert.equal(response.status, 400, message);
    const result = await json(response);
    assertError(result, "INVALID_REQUEST");
    assert.equal(result.error.message, message);
  }
  assert.equal(env.simple_2ch_db.sqlite.prepare("SELECT COUNT(*) AS n FROM posts").get().n, 10);
});

test("POST /posts: JSON が不正・型が違う・Content-Type が違うときは 400 INVALID_REQUEST", async () => {
  const env = sampleEnv();
  const bodies = ["{", "[]", "null", '"a"', JSON.stringify({ name: 1, message: "a" }), JSON.stringify({ mail: [], message: "a" }), JSON.stringify({}), JSON.stringify({ message: 5 })];
  for (const body of bodies) {
    const response = await apiCall(env, "/posts", { method: "POST", headers: ip(), body });
    assert.equal(response.status, 400, body);
    assertError(await json(response), "INVALID_REQUEST");
  }
  const text = await worker.fetch(new Request(`${ORIGIN}/api/v1/posts`, {
    method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}",
  }), env);
  assert.equal(text.status, 400);
});

test("POST /posts: リクエストが 256 KiB を超えると 413 PAYLOAD_TOO_LARGE", async () => {
  const env = sampleEnv();
  const response = await apiCall(env, "/posts", { method: "POST", headers: ip(), body: { message: "a".repeat(256 * 1024) } });
  assert.equal(response.status, 413);
  assertError(await json(response), "PAYLOAD_TOO_LARGE");
});

test("POST /posts: 連続投稿規制は 429 RATE_LIMITED(HTML と同じ ID 単位)、上限は 409 THREAD_FULL", async () => {
  const env = sampleEnv();
  const headers = { "CF-Connecting-IP": "192.0.2.99" };
  for (let i = 0; i < 5; i++) {
    assert.equal((await apiCall(env, "/posts", { method: "POST", headers, body: { message: `m${i}` } })).status, 201);
  }
  const limited = await apiCall(env, "/posts", { method: "POST", headers, body: { message: "6" } });
  assert.equal(limited.status, 429);
  const body = await json(limited);
  assertError(body, "RATE_LIMITED");
  assert.equal(body.error.message, "連続投稿ですか？？ 5回");
  const validate = await apiCall(env, "/posts/validate", { method: "POST", headers, body: { message: "6" } });
  assert.equal(validate.status, 429, "validate は現在の規制状態を返す");

  const full = sampleEnv();
  fillPosts(full, 11, 5000);
  for (const path of ["/posts", "/posts/validate"]) {
    const response = await apiCall(full, path, { method: "POST", headers: ip(), body: { message: "a" } });
    assert.equal(response.status, 409, path);
    assertError(await json(response), "THREAD_FULL");
  }
});

test("POST /posts: ID_SEED が未設定なら 500 INTERNAL_ERROR で保存しない", async () => {
  const env = sampleEnv({ ID_SEED: undefined });
  const response = await apiCall(env, "/posts", { method: "POST", headers: ip(), body: { message: "a" } });
  assert.equal(response.status, 500);
  assertError(await json(response), "INTERNAL_ERROR");
  assert.equal(env.simple_2ch_db.sqlite.prepare("SELECT COUNT(*) AS n FROM posts").get().n, 10);
});

// ---------- 共通の制限 ----------

test("別オリジンからの書き込みは 403。CORS は許可しない", async () => {
  const env = sampleEnv();
  const response = await apiCall(env, "/posts", { method: "POST", headers: { Origin: "https://evil.example", ...ip() }, body: { message: "a" } });
  assert.equal(response.status, 403);
  assertError(await json(response), "ORIGIN_FORBIDDEN");
  const same = await apiCall(env, "/posts", { method: "POST", headers: { Origin: ORIGIN, ...ip() }, body: { message: "a" } });
  assert.equal(same.status, 201);
  const read = await apiCall(env, "/thread", { token: null, headers: { Origin: "https://other.example" } });
  assert.equal(read.headers.get("Access-Control-Allow-Origin"), null);
});

test("HTTPS が必須(localhost を除く)", async () => {
  const env = sampleEnv();
  const insecure = await worker.fetch(new Request("http://bbs.example.test/api/v1/thread"), env);
  assert.equal(insecure.status, 400);
  assertError(await json(insecure), "INVALID_REQUEST");
  for (const host of ["http://localhost:8787", "http://127.0.0.1:8787"]) {
    const response = await worker.fetch(new Request(`${host}/api/v1/thread`), env);
    assert.equal(response.status, 200, host);
  }
});

test("HEAD /thread は GET と同じステータスで本文なし", async () => {
  const env = sampleEnv();
  const head = await apiCall(env, "/thread", { method: "HEAD", token: null });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("初期データが 1 番だけのスレッドでも JSON で扱える", async () => {
  const env = makeEnv();
  seedMinimal(env);
  const { thread } = await json(await apiCall(env, "/thread", { token: null }));
  assert.deepEqual([thread.post_count, thread.latest_post_no, thread.title], [1, 1, "テストスレ"]);
});
