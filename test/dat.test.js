import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { mock } from "node:test";
import {
  bytesOf, call, decodeSjis, makeEnv, readBase, sampleLines, seedMinimal, seedSample, setModified, postForm,
} from "./helpers.js";

afterEach(() => mock.restoreAll());

const SAMPLE_DAT = sampleLines().join("\n") + "\n";
const DAT_PATH = "/simple/dat/1795000000.dat";
const MODIFIED = new Date(1700000000000).toUTCString();

function sampleEnv() {
  const env = makeEnv();
  seedSample(env);
  return env;
}

async function text(response) {
  return decodeSjis(await bytesOf(response));
}

// ---------- raw ----------

test("raw=0.0: 全件。ステータス行は +OK size/2048K で、size は本文のバイト数", async () => {
  const env = sampleEnv();
  const response = await call(env, `${readBase}/?raw=0.0`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/plain; charset=Shift_JIS");
  assert.equal(response.headers.get("Last-Modified"), MODIFIED);
  assert.equal(response.headers.get("Cache-Control"), "no-cache");
  const bytes = await bytesOf(response);
  assert.equal(Number(response.headers.get("Content-Length")), bytes.length);
  const [status, ...rest] = decodeSjis(bytes).split("\n");
  const body = rest.join("\n");
  assert.equal(body, SAMPLE_DAT);
  const size = new TextEncoder().encode(status).length; // 状態行は ASCII
  assert.match(status, /^\+OK \d+\/2048K$/);
  const dat = await bytesOf(await call(env, DAT_PATH));
  assert.equal(status, `+OK ${dat.length}/2048K`);
  assert.equal(bytes.length, size + 1 + dat.length);
});

test("raw: N の省略・負・数字以外は 0 とし、S は無視する", async () => {
  const env = sampleEnv();
  const full = await text(await call(env, `${readBase}/?raw=0.0`));
  for (const value of [".1234", "-5.0", "abc.7", "0.999999", "0"]) {
    assert.equal(await text(await call(env, `${readBase}/?raw=${value}`)), full, `raw=${value}`);
  }
});

test("raw=N.S: N+1 番以降の差分。S は見ない", async () => {
  const env = sampleEnv();
  for (const value of ["5.0", "5.1", "5.99999"]) {
    const result = await text(await call(env, `${readBase}/?raw=${value}`));
    const [status, ...rest] = result.split("\n");
    const expected = sampleLines().slice(5).join("\n") + "\n";
    assert.equal(rest.join("\n"), expected, `raw=${value}`);
    assert.match(status, /^\+OK \d+\/2048K$/);
  }
});

test("raw=N.S: N が最終レス番号のときは本文なしの +OK 0/2048K", async () => {
  const env = sampleEnv();
  const response = await call(env, `${readBase}/?raw=10.123`);
  assert.equal(response.status, 200);
  assert.equal(await text(response), "+OK 0/2048K\n");
});

test("raw=N.S: N が最終レス番号を超えると、同期のずれのエラー(HTTP 200)", async () => {
  const env = sampleEnv();
  const response = await call(env, `${readBase}/?raw=11.0`);
  assert.equal(response.status, 200);
  assert.equal(await text(response), "-ERR どこかであぼーんがあったみたいです。\n");
});

test("raw=0.0 と st/to/ls: +PARTIAL と Res(バイト位置の Range は付けない)", async () => {
  const env = sampleEnv();
  const lines = sampleLines();
  const cases = [
    ["st=3&to=5", 3, 5],
    ["st=8", 8, 10],
    ["to=2", 1, 2],
    ["ls=3", 8, 10],
    ["ls=50", 1, 10],
    ["ls=1", 10, 10], // 【設計判断】raw でも最新 1 件
    ["st=99", 1, 10], // 範囲外は 1
    ["to=99", 1, 10], // 範囲外は最終
    ["st=6&to=3", 6, 6], // first > last のとき last = first
    ["st=2&ls=3", 8, 10], // ls が優先
  ];
  for (const [query, first, last] of cases) {
    const result = await text(await call(env, `${readBase}/?raw=0.0&${query}`));
    const [status, ...rest] = result.split("\n");
    const expected = lines.slice(first - 1, last).join("\n") + "\n";
    assert.equal(rest.join("\n"), expected, query);
    assert.match(status, new RegExp(`^\\+PARTIAL \\d+/2048K\\tRes:${first}-${last}/10$`), query);
    assert.doesNotMatch(status, /Range:/);
  }
});

test("raw: N=0 の差分形式(raw=.S)でも st/to/ls は有効、N>0 では無視する【R-1 の仮決定】", async () => {
  const env = sampleEnv();
  const lines = sampleLines();
  const partial = await text(await call(env, `${readBase}/?raw=.100&st=9`));
  assert.match(partial.split("\n")[0], /^\+PARTIAL \d+\/2048K\tRes:9-10\/10$/);
  assert.equal(partial.split("\n").slice(1).join("\n"), lines.slice(8).join("\n") + "\n");

  const ignored = await text(await call(env, `${readBase}/?raw=5.100&st=1&to=2&ls=3`));
  assert.match(ignored.split("\n")[0], /^\+OK /);
  assert.equal(ignored.split("\n").slice(1).join("\n"), lines.slice(5).join("\n") + "\n");
});

test("raw: クエリ形式、末尾の / と {range} を省いた形でも同じ応答", async () => {
  const env = sampleEnv();
  const expected = await text(await call(env, `${readBase}/?raw=3.0`));
  for (const path of [
    `${readBase}?raw=3.0`,
    `/test/read.cgi?bbs=simple&key=1795000000&raw=3.0`,
  ]) {
    assert.equal(await text(await call(env, path)), expected, path);
  }
});

test("raw: 板・スレッドが違う、またはスレッドがないときは -ERR そんな板orスレッドないです。(HTTP 200)", async () => {
  const env = sampleEnv();
  for (const path of [
    `/test/read.cgi/other/1795000000/?raw=0.0`,
    `/test/read.cgi/simple/1234567890/?raw=0.0`,
  ]) {
    const response = await call(env, path);
    assert.equal(response.status, 200);
    assert.equal(await text(response), "-ERR そんな板orスレッドないです。\n");
  }
  const empty = makeEnv();
  assert.equal(await text(await call(empty, `${readBase}/?raw=0.0`)), "-ERR そんな板orスレッドないです。\n");
});

test("raw: If-Modified-Since が最終更新以降なら 304(本文なし)、前なら 200", async () => {
  const env = sampleEnv();
  const same = await call(env, `${readBase}/?raw=0.0`, { headers: { "If-Modified-Since": MODIFIED } });
  assert.equal(same.status, 304);
  assert.equal((await bytesOf(same)).length, 0);
  assert.equal(same.headers.get("Last-Modified"), MODIFIED);

  const later = await call(env, `${readBase}/?raw=0.0`, { headers: { "If-Modified-Since": new Date(1800000000000).toUTCString() } });
  assert.equal(later.status, 304);

  const earlier = await call(env, `${readBase}/?raw=0.0`, { headers: { "If-Modified-Since": new Date(1699999990000).toUTCString() } });
  assert.equal(earlier.status, 200);

  const invalid = await call(env, `${readBase}/?raw=0.0`, { headers: { "If-Modified-Since": "yesterday" } });
  assert.equal(invalid.status, 200);
});

test("raw: 最終更新が現在から 2 秒以内のときは 304 にならない(同じ秒の 2 回目の更新を隠さない)", async () => {
  const env = sampleEnv();
  const now = 1_800_000_000_000;
  mock.method(Date, "now", () => now);
  setModified(env, now - 500);
  const since = new Date(now).toUTCString();
  const fresh = await call(env, `${readBase}/?raw=0.0`, { headers: { "If-Modified-Since": since } });
  assert.equal(fresh.status, 200);

  setModified(env, now - 2001);
  const settled = await call(env, `${readBase}/?raw=0.0`, { headers: { "If-Modified-Since": since } });
  assert.equal(settled.status, 304);
});

test("raw: HEAD は GET と同じステータス・ヘッダー(Content-Length を含む)で本文なし", async () => {
  const env = sampleEnv();
  const get = await call(env, `${readBase}/?raw=0.0`);
  const head = await call(env, `${readBase}/?raw=0.0`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal((await bytesOf(head)).length, 0);
  for (const name of ["content-type", "content-length", "last-modified", "cache-control"]) {
    assert.equal(head.headers.get(name), get.headers.get(name), name);
  }
  const notModified = await call(env, `${readBase}/?raw=0.0`, { method: "HEAD", headers: { "If-Modified-Since": MODIFIED } });
  assert.equal(notModified.status, 304);
});

test("raw: 空の raw は raw モードではなく HTML", async () => {
  const env = sampleEnv();
  const response = await call(env, `${readBase}/?raw=`);
  assert.match(response.headers.get("Content-Type"), /text\/html/);
});

// ---------- dat の直接取得 ----------

test("dat: 全体は raw の全件と同じ内容で、ステータス行がない", async () => {
  const env = sampleEnv();
  const response = await call(env, DAT_PATH);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/plain; charset=Shift_JIS");
  assert.equal(response.headers.get("Accept-Ranges"), "bytes");
  assert.equal(response.headers.get("Last-Modified"), MODIFIED);
  assert.equal(response.headers.get("Cache-Control"), "no-cache");
  const bytes = await bytesOf(response);
  assert.equal(Number(response.headers.get("Content-Length")), bytes.length);
  assert.equal(decodeSjis(bytes), SAMPLE_DAT);
});

test("dat: Range bytes=N- は 206 と Content-Range、N 以降のバイト列", async () => {
  const env = sampleEnv();
  const full = await bytesOf(await call(env, DAT_PATH));
  for (const start of [0, 1, 100, full.length - 1]) {
    const response = await call(env, DAT_PATH, { headers: { Range: `bytes=${start}-` } });
    assert.equal(response.status, 206, `N=${start}`);
    assert.equal(response.headers.get("Content-Range"), `bytes ${start}-${full.length - 1}/${full.length}`);
    const part = await bytesOf(response);
    assert.equal(Number(response.headers.get("Content-Length")), part.length);
    assert.deepEqual([...part], [...full.slice(start)]);
  }
});

test("dat: N が全体の長さ以上なら 416 と Content-Range: bytes */全体の長さ", async () => {
  const env = sampleEnv();
  const full = await bytesOf(await call(env, DAT_PATH));
  for (const start of [full.length, full.length + 1000]) {
    const response = await call(env, DAT_PATH, { headers: { Range: `bytes=${start}-` } });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get("Content-Range"), `bytes */${full.length}`);
  }
});

test("dat: 未対応の Range 形式は Range を無視して 200 で全体を返す", async () => {
  const env = sampleEnv();
  const full = await bytesOf(await call(env, DAT_PATH));
  for (const range of ["bytes=-5", "bytes=0-10", "bytes=0-1,5-6", "items=0-", "bytes=abc-"]) {
    const response = await call(env, DAT_PATH, { headers: { Range: range } });
    assert.equal(response.status, 200, range);
    assert.deepEqual([...(await bytesOf(response))], [...full], range);
  }
});

test("dat: If-Modified-Since は Range より先に判定する(304 を優先)", async () => {
  const env = sampleEnv();
  const response = await call(env, DAT_PATH, { headers: { "If-Modified-Since": MODIFIED, Range: "bytes=10-" } });
  assert.equal(response.status, 304);
  assert.equal((await bytesOf(response)).length, 0);
});

test("dat: HEAD は GET・206 と同じステータスとヘッダーで本文なし", async () => {
  const env = sampleEnv();
  const get = await call(env, DAT_PATH);
  const head = await call(env, DAT_PATH, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal((await bytesOf(head)).length, 0);
  for (const name of ["content-type", "content-length", "last-modified", "accept-ranges"]) {
    assert.equal(head.headers.get(name), get.headers.get(name), name);
  }
  const partial = await call(env, DAT_PATH, { method: "HEAD", headers: { Range: "bytes=10-" } });
  assert.equal(partial.status, 206);
  assert.match(partial.headers.get("Content-Range"), /^bytes 10-\d+\/\d+$/);
  const tail = await call(env, DAT_PATH, { method: "HEAD", headers: { Range: "bytes=99999-" } });
  assert.equal(tail.status, 416);
});

test("dat: 板・スレッドが違う、またはスレッドがないときは 404(text/plain)", async () => {
  const env = sampleEnv();
  for (const path of ["/other/dat/1795000000.dat", "/simple/dat/1234567890.dat"]) {
    const response = await call(env, path);
    assert.equal(response.status, 404);
    assert.match(response.headers.get("Content-Type"), /^text\/plain/);
  }
  assert.equal((await call(makeEnv(), DAT_PATH)).status, 404);
});

// ---------- JD(専用ブラウザ)の挙動の再現 ----------
// 前セッションで JD のソースから確認した事実:
//  - Range の開始位置は「手元のサイズ−1」(nodetree2ch.cpp:159)
//  - 再開時、応答の先頭が改行なら成功(その 1 文字を捨てる)。206 で先頭が改行でなければ破損扱い(nodetreebase.cpp:1264-1292)
//  - 304 と 416 はエラー扱いにしない(nodetreebase.cpp:1352-1377)
//  - If-Modified-Since を付ける。再開時は gzip を受け取らない(loader.cpp:1050-1059)

// JD の更新取得: 手元の dat(bytes)に続きを足す。破損なら null(全体を取り直す)。
async function jdUpdate(env, local, ifModifiedSince) {
  const headers = { Range: `bytes=${local.length - 1}-`, "Accept-Encoding": "identity" };
  if (ifModifiedSince) headers["If-Modified-Since"] = ifModifiedSince;
  const response = await call(env, DAT_PATH, { headers });
  if (response.status === 304 || response.status === 416) return { local, status: response.status, response, received: 0 };
  const body = await bytesOf(response);
  if (response.status === 200) return { local: body, status: 200, response, received: body.length }; // Range を無視された場合は全体
  assert.equal(response.status, 206);
  if (body[0] !== 0x0a) return { local: null, status: 206, response, received: body.length }; // 先頭が改行でない: 破損
  const merged = new Uint8Array(local.length + body.length - 1);
  merged.set(local);
  merged.set(body.slice(1), local.length);
  return { local: merged, status: 206, response, received: body.length };
}

function prefixThroughLine(full, lineCount) {
  let end = -1;
  for (let i = 0; i < lineCount; i++) end = full.indexOf(0x0a, end + 1);
  return full.slice(0, end + 1);
}

test("JD: 手元のサイズ−1 から取得すると、応答の先頭が改行で、続きを足すと全体に一致する", async () => {
  const env = sampleEnv();
  const full = await bytesOf(await call(env, DAT_PATH));
  for (const lines of [1, 5, 9]) {
    const local = prefixThroughLine(full, lines);
    const result = await jdUpdate(env, local);
    assert.equal(result.status, 206, `${lines} 行`);
    assert.equal(result.response.headers.get("Content-Range"), `bytes ${local.length - 1}-${full.length - 1}/${full.length}`);
    assert.equal(result.response.headers.get("Content-Encoding"), null);
    assert.deepEqual([...result.local], [...full], `${lines} 行`);
  }
});

test("JD: 更新なしのとき、If-Modified-Since に対して 304。エラー扱いにならない", async () => {
  const env = sampleEnv();
  const full = await bytesOf(await call(env, DAT_PATH));
  const result = await jdUpdate(env, full, MODIFIED);
  assert.equal(result.status, 304);
  assert.deepEqual([...result.local], [...full]);
});

test("JD: 更新時刻だけ新しく内容が同じなら、206 で改行 1 文字だけが返り、手元は変わらない", async () => {
  const env = sampleEnv();
  const full = await bytesOf(await call(env, DAT_PATH));
  const old = new Date(1600000000000).toUTCString();
  const result = await jdUpdate(env, full, old);
  assert.equal(result.status, 206);
  assert.equal(result.received, 1);
  assert.deepEqual([...result.local], [...full]);
});

test("JD: 新しい投稿があれば、続きだけが取得できて全体に一致する", async () => {
  const env = makeEnv();
  seedMinimal(env);
  const before = await bytesOf(await call(env, DAT_PATH));
  const posted = await postForm(env, { FROM: "テスト", mail: "sage", MESSAGE: "追加\n2行目 😀" }, { "CF-Connecting-IP": "192.0.2.1" });
  assert.equal(posted.status, 303);
  const result = await jdUpdate(env, before);
  assert.equal(result.status, 206);
  const full = await bytesOf(await call(env, DAT_PATH));
  assert.deepEqual([...result.local], [...full]);
  assert.match(decodeSjis(full), /テスト<>sage<>\d{4}\/\d\d\/\d\d\(.\) \d\d:\d\d:\d\d ID:\S{8}<> 追加 <br> 2行目 &#128512; <>\n$/);
});

test("JD: Range を無視した 200(未対応形式)は全体を受け取る", async () => {
  const env = sampleEnv();
  const full = await bytesOf(await call(env, DAT_PATH));
  const response = await call(env, DAT_PATH, { headers: { Range: "bytes=0-10" } });
  assert.equal(response.status, 200);
  assert.deepEqual([...(await bytesOf(response))], [...full]);
});

const ABON = "UPDATE posts SET name = 'あぼーん', mail = '', date_text = 'あぼーん', poster_id = '', message = 'あぼーん' WHERE no = ";

test("JD: 手元より前の行をあぼーんすると、続きの先頭が改行でなくなり(または 416)、取り直しで検出できる", async () => {
  const env = sampleEnv();
  const local = prefixThroughLine(await bytesOf(await call(env, DAT_PATH)), 9);
  env.simple_2ch_db.exec(ABON + "4");
  const result = await jdUpdate(env, local);
  assert.ok(result.status === 416 || result.local === null, `status=${result.status}`);

  // 検出後は全体を取り直す(Range なし)と、あぼーん後の内容になる
  const refetched = decodeSjis(await bytesOf(await call(env, DAT_PATH)));
  assert.match(refetched, /あぼーん<><>あぼーん<> あぼーん <>\n/);
});

test("JD: 手元より後ろの行をあぼーんしても、手元の位置から続きが取れる(取得済みの行は更新されない)", async () => {
  const env = sampleEnv();
  const full = await bytesOf(await call(env, DAT_PATH));
  const local = prefixThroughLine(full, 9);
  env.simple_2ch_db.exec(ABON + "10");
  const result = await jdUpdate(env, local);
  assert.equal(result.status, 206);
  assert.ok(result.local !== null);
  assert.match(decodeSjis(result.local), /あぼーん<><>あぼーん<> あぼーん <>\n$/);
});

test("あぼーん後: 全件取得・範囲取得には書き換え後の値が出て、差分取得(N が対象以降)には出ない", async () => {
  const env = sampleEnv();
  env.simple_2ch_db.exec(ABON + "4");
  const abon = "あぼーん<><>あぼーん<> あぼーん <>\n";

  const full = await text(await call(env, `${readBase}/?raw=0.0`));
  assert.ok(full.includes(abon));
  const partial = await text(await call(env, `${readBase}/?raw=0.0&st=4&to=4`));
  assert.equal(partial.split("\n").slice(1).join("\n"), abon);
  assert.ok((await text(await call(env, DAT_PATH))).includes(abon));

  const diffAfter = await text(await call(env, `${readBase}/?raw=4.0`)); // N=4: 5 番以降だけ
  assert.ok(!diffAfter.includes("あぼーん"));
  const diffBefore = await text(await call(env, `${readBase}/?raw=3.0`)); // N=3: 4 番以降 → 書き換え後が出る
  assert.ok(diffBefore.includes(abon));

  // 更新時刻が進むため、全件取得の 304 は返らない
  const stale = await call(env, `${readBase}/?raw=0.0`, { headers: { "If-Modified-Since": MODIFIED } });
  assert.equal(stale.status, 200);
});

// ---------- subject.txt ----------

const SUBJECT_PATH = "/simple/subject.txt";

test("subject: スレッドがあれば1行(dat名<>タイトル (レス数))を Shift_JIS で返す", async () => {
  const env = sampleEnv();
  const response = await call(env, SUBJECT_PATH);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/plain; charset=Shift_JIS");
  assert.equal(response.headers.get("Last-Modified"), MODIFIED);
  assert.equal(response.headers.get("Cache-Control"), "no-cache");
  const bytes = await bytesOf(response);
  assert.equal(Number(response.headers.get("Content-Length")), bytes.length);
  assert.equal(decodeSjis(bytes), "1795000000.dat<>サンプルスレッド (10)\n");
});

test("subject: レス数は現在の最大番号(1件だけなら (1))", async () => {
  const env = makeEnv();
  seedMinimal(env);
  const response = await call(env, SUBJECT_PATH);
  assert.equal(response.status, 200);
  assert.equal(await text(response), "1795000000.dat<>テストスレ (1)\n");
});

test("subject: スレッドがないとき、または板が違うときは 404", async () => {
  const env = makeEnv();
  assert.equal((await call(env, SUBJECT_PATH)).status, 404);
  seedMinimal(env);
  assert.equal((await call(env, "/other/subject.txt")).status, 404);
});

test("subject: If-Modified-Since が最終更新以降なら 304(本文なし)", async () => {
  const env = sampleEnv();
  const response = await call(env, SUBJECT_PATH, { headers: { "If-Modified-Since": MODIFIED } });
  assert.equal(response.status, 304);
  assert.equal(response.headers.get("Last-Modified"), MODIFIED);
  assert.equal((await bytesOf(response)).length, 0);
});

test("subject: HEAD は GET と同じステータス・ヘッダーで本文なし", async () => {
  const env = sampleEnv();
  const response = await call(env, SUBJECT_PATH, { method: "HEAD" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/plain; charset=Shift_JIS");
  assert.ok(Number(response.headers.get("Content-Length")) > 0);
  assert.equal((await bytesOf(response)).length, 0);
});

// ---------- dat_lines ----------

function lineCount(env) {
  return env.simple_2ch_db.sqlite.prepare("SELECT COUNT(*) AS n FROM dat_lines").get().n;
}

test("dat_lines: 初回の dat 取得で行が生成され、2 回目は同じバイト列が返る", async () => {
  const env = sampleEnv();
  assert.equal(lineCount(env), 0);
  const first = await bytesOf(await call(env, DAT_PATH));
  assert.equal(lineCount(env), 10);
  const second = await bytesOf(await call(env, DAT_PATH));
  assert.deepEqual(second, first);
  assert.equal(decodeSjis(second), SAMPLE_DAT);
});

test("dat_lines: あぼーん(ADMIN の UPDATE のみ)が、キャッシュ操作なしで dat に反映される", async () => {
  const env = sampleEnv();
  await call(env, DAT_PATH);
  assert.equal(lineCount(env), 10);
  env.simple_2ch_db.exec(ABON + "5");
  const dat = await text(await call(env, DAT_PATH));
  assert.ok(dat.includes("あぼーん<><>あぼーん<> あぼーん <>\n"));
  const row = env.simple_2ch_db.sqlite.prepare("SELECT name, message FROM dat_lines WHERE no = 5").get();
  assert.deepEqual([row.name, row.message], ["あぼーん", "あぼーん"]);
});

test("dat_lines: 投稿が増えると、次回の dat 取得で新しい行が生成される", async () => {
  const env = sampleEnv();
  await call(env, DAT_PATH);
  assert.equal(lineCount(env), 10);
  const posted = await postForm(env, { MESSAGE: "追加の書き込み" });
  assert.equal(posted.status, 303);
  const dat = await text(await call(env, DAT_PATH));
  assert.ok(dat.includes(" 追加の書き込み <>\n"));
  assert.equal(lineCount(env), 11);
});

test("dat_lines: スレッドタイトルを SQL で変えると、1 行目が作り直される", async () => {
  const env = sampleEnv();
  await call(env, DAT_PATH);
  env.simple_2ch_db.exec("UPDATE thread SET title = '新しいタイトル' WHERE id = 1");
  const dat = await text(await call(env, DAT_PATH));
  assert.ok(dat.split("\n")[0].endsWith("<>新しいタイトル"));
});
