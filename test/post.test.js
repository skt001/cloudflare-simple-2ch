import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import { PostError, formatJst, makePosterId, normalizeInput, unescapeText } from "../src/core.js";
import { call, fillPosts, form, makeEnv, postForm, readBase, seedMinimal } from "./helpers.js";

afterEach(() => mock.restoreAll());

function newEnv(overrides) {
  const env = makeEnv(overrides);
  seedMinimal(env);
  return env;
}

function row(env, no) {
  return env.simple_2ch_db.sqlite.prepare("SELECT * FROM posts WHERE no = ?").get(no);
}

function count(env) {
  return env.simple_2ch_db.sqlite.prepare("SELECT COUNT(*) AS n FROM posts").get().n;
}

async function errorOf(response) {
  return (await response.text()).match(/<b>ＥＲＲＯＲ：(.*)<\/b>/)?.[1];
}

let ipCounter = 0;
function freshIp() {
  ipCounter++;
  return { "CF-Connecting-IP": `203.0.113.${ipCounter % 250}` };
}

// ---------- 正規化(§5.3) ----------

test("正規化: 改行・制御文字・タブ・前後の空白", () => {
  const result = normalizeInput({ name: "  太郎\r\n\u0007 ", mail: " a\tb\n ", message: "\n\r\n  a\r\nb\rc\u0000\u007f\td \n\n" });
  assert.deepEqual(result, { name: "太郎", mail: "a b", message: "a\nb\nc d" });
});

test("正規化: 名前の # 以降の切り捨て、◆ の置換、空なら既定名", () => {
  assert.equal(normalizeInput({ name: "名前#トリップ", message: "m" }).name, "名前");
  assert.equal(normalizeInput({ name: "#abc", message: "m" }).name, "名無しさん");
  assert.equal(normalizeInput({ name: "◆偽物◆", message: "m" }).name, "◇偽物◇");
  assert.equal(normalizeInput({ name: "", message: "m" }).name, "名無しさん");
  assert.equal(normalizeInput({ name: " \n ", message: "m" }).name, "名無しさん");
  assert.equal(normalizeInput({ name: "a#b#c", message: "m" }).name, "a");
});

test("正規化: 本文が空なら「本文がありません」", () => {
  for (const message of ["", "  \n\t ", "\u0000\u0001"]) {
    assert.throws(() => normalizeInput({ message }), (error) => error instanceof PostError && error.message === "本文がありません");
  }
});

test("制限値の境界(UTF-8 の文字数。サロゲートペアは 1 文字)", () => {
  const fails = (input, message) => assert.throws(
    () => normalizeInput(input), (error) => error instanceof PostError && error.kind === "invalid" && error.message === message
  );
  assert.equal(normalizeInput({ name: "あ".repeat(64), message: "m" }).name.length, 64);
  fails({ name: "あ".repeat(65), message: "m" }, "名前が長すぎます");
  assert.equal(normalizeInput({ name: "😀".repeat(64), message: "m" }).name, "😀".repeat(64));
  fails({ name: "😀".repeat(65), message: "m" }, "名前が長すぎます");

  assert.equal(normalizeInput({ mail: "a".repeat(64), message: "m" }).mail.length, 64);
  fails({ mail: "a".repeat(65), message: "m" }, "メールアドレスが長すぎます");

  const lines = (n) => Array.from({ length: n }, () => "a").join("\n");
  assert.equal(normalizeInput({ message: "あ".repeat(1024) }).message.length, 1024);
  fails({ message: "あ".repeat(1025) }, "長すぎる行があります");
  // 行数に制限はない(101 行でも受理する)
  assert.equal(normalizeInput({ message: lines(101) }).message.split("\n").length, 101);

  // 本文 4096 文字ちょうど(1 行 1024 文字以内、改行を含む)は受理し、4097 文字は拒否する
  const exact = ("あ".repeat(1023) + "\n").repeat(3) + "あ".repeat(1024);
  assert.equal([...exact].length, 4096);
  assert.equal([...normalizeInput({ message: exact }).message].length, 4096);
  const over = "あ".repeat(1024) + "\n" + "あ".repeat(1023) + "\n" + "あ".repeat(1023) + "\n" + "あ".repeat(1024);
  assert.equal([...over].length, 4097);
  fails({ message: over }, "本文が長すぎます");
});

test("エスケープの戻し(JSON 用)は 1 回だけ戻す", () => {
  assert.equal(unescapeText("&amp;lt; &lt;b&gt; &quot;q&quot; &amp;"), "&lt; <b> \"q\" &");
});

// ---------- 日付・ID(§5.5) ----------

test("日付: JST の YYYY/MM/DD(曜) HH:MM:SS(0 埋め、日付をまたぐ)", () => {
  assert.equal(formatJst(Date.UTC(2026, 10, 19, 15, 30, 45)), "2026/11/20(金) 00:30:45");
  assert.equal(formatJst(Date.UTC(2026, 0, 1, 0, 0, 0)), "2026/01/01(木) 09:00:00");
  assert.equal(formatJst(Date.UTC(2026, 10, 15, 14, 59, 59)), "2026/11/15(日) 23:59:59");
  assert.equal(formatJst(Date.UTC(2026, 10, 15, 15, 0, 0)), "2026/11/16(月) 00:00:00");
});

test("ID: 8 文字の Base64。同じ日・同じ IP・同じ種で同じ値、日付・IP・種が変わると別の値", async () => {
  const noon = Date.UTC(2026, 10, 18, 3, 0, 0); // JST 12:00
  const id = await makePosterId("seed", "192.0.2.1", noon);
  assert.match(id, /^[A-Za-z0-9+/]{8}$/);
  assert.equal(await makePosterId("seed", "192.0.2.1", noon + 3600_000), id);
  assert.notEqual(await makePosterId("seed", "192.0.2.2", noon), id);
  assert.notEqual(await makePosterId("other", "192.0.2.1", noon), id);
  assert.notEqual(await makePosterId("seed", "192.0.2.1", noon + 24 * 3600_000), id);
  // JST の日付境界(UTC 15:00)で変わる
  const before = Date.UTC(2026, 10, 18, 14, 59, 59);
  assert.equal(await makePosterId("seed", "192.0.2.1", before), id);
  assert.notEqual(await makePosterId("seed", "192.0.2.1", before + 1000), id);
  await assert.rejects(() => makePosterId("", "192.0.2.1", noon), (error) => error.kind === "config");
  await assert.rejects(() => makePosterId(undefined, "192.0.2.1", noon), (error) => error.kind === "config");
});

// ---------- POST /test/bbs.cgi(§5) ----------

test("投稿: 303 で最新 50 件へ。保存形式(エスケープ・改行・日付・ID・source)", async () => {
  const now = Date.UTC(2026, 10, 19, 15, 30, 45) + 123;
  mock.method(Date, "now", () => now);
  const env = newEnv();
  const response = await postForm(env, {
    FROM: "太郎#tr◆ip", mail: 'a"<b>&', MESSAGE: "<script>&amp; >>1\r\n2行目\r\n",
  }, { "CF-Connecting-IP": "192.0.2.10" });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("Location"), `${readBase}/l50`);

  const saved = row(env, 2);
  assert.equal(saved.name, "太郎");
  assert.equal(saved.mail, "a&quot;&lt;b&gt;&amp;");
  assert.equal(saved.message, "&lt;script&gt;&amp;amp; &gt;&gt;1\n2行目");
  assert.equal(saved.date_text, "2026/11/20(金) 00:30:45");
  assert.equal(saved.posted_at, now);
  assert.equal(saved.source, "web");
  assert.equal(saved.poster_id, await makePosterId("test-seed", "192.0.2.10", now));
  assert.ok(!saved.message.includes("<br>"));
});

test("投稿: 空の名前は既定名、名前の ◆ は ◇ になり、HTML にそのまま表示される", async () => {
  const env = newEnv();
  await postForm(env, { FROM: "", mail: "", MESSAGE: "a" }, freshIp());
  await postForm(env, { FROM: "◆管理人", mail: "", MESSAGE: "b" }, freshIp());
  assert.equal(row(env, 2).name, "名無しさん");
  assert.equal(row(env, 3).name, "◇管理人");
  const page = await (await call(env, `${readBase}/2-3`)).text();
  assert.ok(page.includes("<b>◇管理人 </b>"));
});

test("投稿: 同じ日・同じ IP は同じ ID、別の IP は別の ID、日付が変わると別の ID", async () => {
  const day = Date.UTC(2026, 10, 18, 3, 0, 0);
  const env = newEnv();
  mock.method(Date, "now", () => day);
  await postForm(env, { MESSAGE: "a" }, { "CF-Connecting-IP": "192.0.2.1" });
  await postForm(env, { MESSAGE: "b" }, { "CF-Connecting-IP": "192.0.2.1" });
  await postForm(env, { MESSAGE: "c" }, { "CF-Connecting-IP": "192.0.2.2" });
  mock.restoreAll();
  mock.method(Date, "now", () => day + 24 * 3600_000);
  await postForm(env, { MESSAGE: "d" }, { "CF-Connecting-IP": "192.0.2.1" });
  const ids = [2, 3, 4, 5].map((no) => row(env, no).poster_id);
  assert.equal(ids[0], ids[1]);
  assert.notEqual(ids[0], ids[2]);
  assert.notEqual(ids[0], ids[3]);
});

test("投稿: 本文なし・長すぎる項目は 400(エラーページ)で、保存されない", async () => {
  const env = newEnv();
  const cases = [
    [{ MESSAGE: "" }, "本文がありません"],
    [{ MESSAGE: "a", FROM: "あ".repeat(65) }, "名前が長すぎます"],
    [{ MESSAGE: "a", mail: "a".repeat(65) }, "メールアドレスが長すぎます"],
    [{ MESSAGE: "あ".repeat(1025) }, "長すぎる行があります"],
    [{ MESSAGE: ("あ".repeat(1000) + "\n").repeat(4) + "あ".repeat(100) }, "本文が長すぎます"],
  ];
  for (const [fields, message] of cases) {
    const response = await postForm(env, fields, freshIp());
    assert.equal(response.status, 400, message);
    assert.equal(await errorOf(response), message);
  }
  assert.equal(count(env), 1);
});

test("投稿: 本文 4096 文字・1 行 1024 文字ちょうどは受理し、行数は制限しない", async () => {
  const env = newEnv();
  const limit = ("あ".repeat(1023) + "\n").repeat(3) + "あ".repeat(1024); // 4096 文字(改行を含む)
  assert.equal([...limit].length, 4096);
  assert.equal((await postForm(env, { MESSAGE: limit }, freshIp())).status, 303);
  assert.equal((await postForm(env, { MESSAGE: Array.from({ length: 1000 }, () => "a").join("\n") }, freshIp())).status, 303);
  assert.equal((await postForm(env, { MESSAGE: "😀".repeat(1024) }, freshIp())).status, 303);
});

test("投稿: リクエスト全体が 256 KiB を超えると 413「文長杉」", async () => {
  const env = newEnv();
  const response = await call(env, "/test/bbs.cgi", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({ bbs: "simple", key: "1795000000", time: "1", MESSAGE: "a".repeat(256 * 1024) }),
  });
  assert.equal(response.status, 413);
  assert.equal(await errorOf(response), "文長杉");
  assert.equal(count(env), 1);
});

test("投稿: time の検証(空・0・現在時刻以上は 400)", async () => {
  const now = 1_795_000_100_000;
  mock.method(Date, "now", () => now);
  const env = newEnv();
  const send = (time) => postForm(env, { MESSAGE: "a", time }, freshIp());

  for (const time of ["", "0", "abc", "000"]) {
    const response = await send(time);
    assert.equal(response.status, 400, `time=${time}`);
    assert.equal(await errorOf(response), "フォーム情報が不正です");
  }
  for (const time of [String(now / 1000), String(now / 1000 + 1), "9999999999"]) {
    const response = await send(time);
    assert.equal(response.status, 400, `time=${time}`);
    assert.equal(await errorOf(response), "ブラウザを立ち上げなおしてみてください");
  }
  assert.equal(count(env), 1);
  assert.equal((await send(String(now / 1000 - 1))).status, 303);
  assert.equal((await send("1795000099abc")).status, 303, "数字以外は除去する");
});

test("投稿: bbs・key の不一致は 404、数字・英数字以外は除去する", async () => {
  const env = newEnv();
  const bad = await postForm(env, { MESSAGE: "a", bbs: "other" }, freshIp());
  assert.equal(bad.status, 404);
  assert.equal(await errorOf(bad), "そんな板orスレッドないです。");
  assert.equal((await postForm(env, { MESSAGE: "a", key: "1234567890" }, freshIp())).status, 404);
  assert.equal((await postForm(env, { MESSAGE: "a", bbs: "sim-ple!", key: "1795-000000x" }, freshIp())).status, 303);
});

test("投稿: Origin が別のホストなら 403。同じホスト・Origin なしは受理する", async () => {
  const env = newEnv();
  const other = await postForm(env, { MESSAGE: "a" }, { Origin: "https://evil.example", ...freshIp() });
  assert.equal(other.status, 403);
  assert.equal(await errorOf(other), "不正なリクエストです");
  assert.equal((await postForm(env, { MESSAGE: "a" }, { Origin: "null", ...freshIp() })).status, 403);
  assert.equal((await postForm(env, { MESSAGE: "a" }, { Origin: "https://bbs.example.test", ...freshIp() })).status, 303);
  assert.equal((await postForm(env, { MESSAGE: "b" }, freshIp())).status, 303);
  assert.equal(count(env), 3);
});

test("投稿: フォーム以外の Content-Type は 400", async () => {
  const env = newEnv();
  const response = await call(env, "/test/bbs.cgi", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal(response.status, 400);
});

test("投稿: subject などの未知の項目は無視する", async () => {
  const env = newEnv();
  const response = await postForm(env, { MESSAGE: "a", subject: "新スレ", extra: "x" }, freshIp());
  assert.equal(response.status, 303);
  assert.equal(count(env), 2);
});

test("連続投稿規制: 同じ ID の 6 回目で拒否(5 回目までは受理)。拒否は記録せず、60 秒後に再び受理する", async () => {
  const start = Date.UTC(2026, 10, 18, 3, 0, 0);
  mock.method(Date, "now", () => start);
  const env = newEnv();
  const headers = { "CF-Connecting-IP": "192.0.2.50" };
  for (let i = 1; i <= 5; i++) {
    assert.equal((await postForm(env, { MESSAGE: `m${i}` }, headers)).status, 303, `${i} 回目`);
  }
  const sixth = await postForm(env, { MESSAGE: "m6" }, headers);
  assert.equal(sixth.status, 429);
  assert.equal(await errorOf(sixth), "連続投稿ですか？？ 5回");
  assert.equal((await postForm(env, { MESSAGE: "m7" }, headers)).status, 429);
  assert.equal(count(env), 6, "拒否された試行は記録しない");

  // 別の送信元は影響を受けない
  assert.equal((await postForm(env, { MESSAGE: "other" }, { "CF-Connecting-IP": "192.0.2.51" })).status, 303);

  // 59 秒後はまだ拒否、60 秒を超えると受理(直近 60 秒の件数で数える)
  mock.restoreAll();
  mock.method(Date, "now", () => start + 59_000);
  assert.equal((await postForm(env, { MESSAGE: "late" }, headers)).status, 429);
  mock.restoreAll();
  mock.method(Date, "now", () => start + 60_001);
  assert.equal((await postForm(env, { MESSAGE: "ok" }, headers)).status, 303);
});

test("レス数の上限: MAX_POSTS(5000)件までは受理し、超えると 409。5001 番は作らない", async () => {
  const env = newEnv();
  fillPosts(env, 2, 4998);
  assert.equal((await postForm(env, { MESSAGE: "4999" }, freshIp())).status, 303);
  assert.equal((await postForm(env, { MESSAGE: "5000" }, freshIp())).status, 303);
  assert.equal(count(env), 5000);

  const over = await postForm(env, { MESSAGE: "5001" }, freshIp());
  assert.equal(over.status, 409);
  assert.equal(await errorOf(over), "レス数の上限に達したため書き込めません");
  assert.equal(count(env), 5000);
  assert.equal(env.simple_2ch_db.sqlite.prepare("SELECT MAX(no) AS m FROM posts").get().m, 5000);
});

test("ID_SEED が未設定のときは投稿を 500 で拒否し、保存しない(閲覧は影響を受けない)", async () => {
  const env = newEnv({ ID_SEED: undefined });
  const response = await postForm(env, { MESSAGE: "a" }, freshIp());
  assert.equal(response.status, 500);
  assert.equal(await errorOf(response), "サーバーの設定が不完全です。");
  assert.equal(count(env), 1);
  assert.equal((await call(env, `${readBase}/`)).status, 200);
});

test("CF-Connecting-IP がなくても投稿でき、同じ代替値として扱う", async () => {
  const env = newEnv();
  assert.equal((await postForm(env, { MESSAGE: "a" })).status, 303);
  assert.equal((await postForm(env, { MESSAGE: "b" })).status, 303);
  assert.equal(row(env, 2).poster_id, row(env, 3).poster_id);
});

test("投稿した内容は HTML・dat・raw に同じ内容で出る(エスケープ・絵文字・改行)", async () => {
  const env = newEnv();
  await postForm(env, { FROM: "<太郎>", MESSAGE: "a < b & c\n😀 >>1" }, freshIp());
  const page = await (await call(env, `${readBase}/2`)).text();
  assert.ok(page.includes("<b>&lt;太郎&gt; </b>"));
  assert.ok(page.includes("<dd> a &lt; b &amp; c <br> 😀 <a href=\"/test/read.cgi/simple/1795000000/1\" target=\"_blank\">&gt;&gt;1</a> <br><br>"));

  const dat = new TextDecoder("shift_jis").decode(new Uint8Array(await (await call(env, "/simple/dat/1795000000.dat")).arrayBuffer()));
  assert.ok(dat.includes("&lt;太郎&gt;<><>"));
  assert.ok(dat.includes("<> a &lt; b &amp; c <br> &#128512; &gt;&gt;1 <>\n"));
});
