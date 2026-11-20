import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

// uploader の test/ と同じ方式: wrangler の開発用サーバー(workerd + ローカル D1)を起動し、HTTP で検証する。
// migrations は wrangler で適用し、初期スレッドは ADMIN.md の雛形で投入する。
// 実際の D1(SQLite)・トリガー・Worker のランタイムで、主要な経路を確認する。

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = path.join(root, "node_modules", ".bin", "wrangler");
const skip = existsSync(wrangler) ? false : "npm install が必要です(wrangler がありません)";

const DB_NAME = "simple-2ch-db";
const KEY = "1795000000";
const READ = `/test/read.cgi/simple/${KEY}`;

let directory;
let server;
let baseUrl;
let output = "";

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}

function environment() {
  return {
    ...process.env,
    XDG_CONFIG_HOME: path.join(directory, "config"),
    WRANGLER_SEND_METRICS: "false",
    NO_COLOR: "1",
    CI: "1",
  };
}

function runWrangler(args) {
  const result = spawnSync(wrangler, args, { cwd: root, env: environment(), encoding: "utf8" });
  assert.equal(result.status, 0, `wrangler ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

before(async () => {
  if (skip) return;
  directory = mkdtempSync(path.join(tmpdir(), "simple-2ch-"));
  const example = readFileSync(path.join(root, "wrangler.example.jsonc"), "utf8");
  const compatibilityDate = /"compatibility_date":\s*"([^"]+)"/.exec(example)[1];
  const config = path.join(directory, "wrangler.json");
  writeFileSync(config, JSON.stringify({
    name: "simple-2ch-test",
    main: path.join(root, "src", "index.js"),
    compatibility_date: compatibilityDate,
    d1_databases: [{
      binding: "DB",
      database_name: DB_NAME,
      database_id: "00000000-0000-0000-0000-000000000001",
      migrations_dir: path.join(root, "migrations"),
    }],
  }));
  const state = path.join(directory, "state");
  const common = ["--config", config, "--local", "--persist-to", state];

  // migrations(トリガーを含む)を wrangler で適用する
  runWrangler(["d1", "migrations", "apply", DB_NAME, ...common]);

  // 初期スレッド: ADMIN.md の雛形
  const admin = readFileSync(path.join(root, "ADMIN.md"), "utf8");
  const init = /```sql\n-- \[template:init\]\n([\s\S]*?)```/.exec(admin)[1];
  const initFile = path.join(directory, "init.sql");
  writeFileSync(initFile, init);
  runWrangler(["d1", "execute", DB_NAME, ...common, "--file", initFile]);

  const port = await freePort();
  server = spawn(wrangler, [
    "dev", "--config", config, "--persist-to", state, "--ip", "127.0.0.1", "--port", String(port),
    "--var", "ID_SEED:integration-seed", "--var", "API_POST_TOKEN:integration-token",
  ], { cwd: root, env: environment(), detached: true });
  baseUrl = `http://127.0.0.1:${port}`;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`wrangler dev が起動しない\n${output}`)), 60_000);
    const onData = (chunk) => {
      output += chunk;
      if (/Ready on http/.test(output)) {
        clearTimeout(timer);
        resolve();
      }
    };
    server.stdout.on("data", onData);
    server.stderr.on("data", onData);
    server.on("exit", (code) => reject(new Error(`wrangler dev が終了した(${code})\n${output}`)));
  });
});

after(() => {
  if (server?.pid) {
    try { process.kill(-server.pid, "SIGKILL"); } catch { /* 終了済み */ }
  }
  if (directory) rmSync(directory, { recursive: true, force: true });
});

const get = (pathname, init) => fetch(`${baseUrl}${pathname}`, init);
const decode = async (response) => new TextDecoder("shift_jis").decode(new Uint8Array(await response.arrayBuffer()));

function form(fields) {
  return new URLSearchParams({
    bbs: "simple", key: KEY, time: String(Math.floor(Date.now() / 1000) - 30), submit: "書き込む", ...fields,
  }).toString();
}

const post = (fields) => get("/test/bbs.cgi", {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form(fields), redirect: "manual",
});

test("初期スレッド(ADMIN.md の雛形)が、HTML・raw・dat・JSON で読める", { skip }, async () => {
  const html = await get(`${READ}/`);
  assert.equal(html.status, 200);
  assert.match(html.headers.get("content-type"), /^text\/html; charset=UTF-8$/i);
  assert.ok((await html.text()).includes("<title>スレッドのタイトル </title>"));

  const raw = await get(`${READ}/?raw=0.0`);
  assert.equal(raw.status, 200);
  assert.match(raw.headers.get("content-type"), /charset=Shift_JIS/i);
  const text = await decode(raw);
  assert.match(text, /^\+OK \d+\/2048K\n名無しさん<><>2026\/11\/19\(木\) 12:00:00 ID:Admin001<> 最初のレスの本文です。 <>スレッドのタイトル\n$/);

  const dat = await get("/simple/dat/1795000000.dat");
  assert.equal(dat.status, 200);
  assert.equal(dat.headers.get("accept-ranges"), "bytes");
  const thread = await (await get("/api/v1/thread")).json();
  assert.equal(thread.thread.post_count, 1);
});

test("実際の D1 で: 投稿 → 最終更新(トリガー)が進み、全 3 ビューに反映される", async (t) => {
  if (skip) return t.skip(skip);
  const before = await (await get("/api/v1/thread")).json();
  const lastModified = (await get(`${READ}/?raw=0.0`)).headers.get("last-modified");
  assert.ok(lastModified);

  await new Promise((resolve) => setTimeout(resolve, 1100));
  const response = await post({ FROM: "太郎#x", mail: "sage", MESSAGE: "本文 <b>&\n2行目 😀" });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), `${READ}/l50`);

  const after = await (await get("/api/v1/thread")).json();
  assert.equal(after.thread.post_count, 2);
  assert.ok(after.thread.updated_at > before.thread.updated_at, "thread.modified_at がトリガーで更新される");
  assert.ok(Math.abs(after.thread.updated_at - Date.now()) < 10_000, "ミリ秒の現在時刻");

  const posts = await (await get("/api/v1/posts")).json();
  assert.deepEqual(posts.posts[1].message, "本文 <b>&\n2行目 😀");
  assert.equal(posts.posts[1].name, "太郎");
  const page = await (await get(`${READ}/2`)).text();
  assert.ok(page.includes("<dd> 本文 &lt;b&gt;&amp; <br> 2行目 😀 <br><br>"));
  const dat = await decode(await get("/simple/dat/1795000000.dat"));
  assert.ok(dat.endsWith("<> 本文 &lt;b&gt;&amp; <br> 2行目 &#128512; <>\n"));
});

test("実際のランタイムで: If-Modified-Since の 304、HEAD、Range の 206・416", async (t) => {
  if (skip) return t.skip(skip);
  await new Promise((resolve) => setTimeout(resolve, 2200));
  const full = await get("/simple/dat/1795000000.dat", { headers: { "Accept-Encoding": "identity" } });
  const bytes = new Uint8Array(await full.arrayBuffer());
  const modified = full.headers.get("last-modified");
  assert.equal(Number(full.headers.get("content-length")), bytes.length);

  const notModified = await get("/simple/dat/1795000000.dat", { headers: { "If-Modified-Since": modified } });
  assert.equal(notModified.status, 304);
  const rawNotModified = await get(`${READ}/?raw=0.0`, { headers: { "If-Modified-Since": modified } });
  assert.equal(rawNotModified.status, 304);

  const head = await get("/simple/dat/1795000000.dat", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");

  // JD と同じ: 手元のサイズ−1 から取得し、先頭が改行であることを確かめる
  const resume = await get("/simple/dat/1795000000.dat", { headers: { Range: `bytes=${bytes.length - 1}-`, "Accept-Encoding": "identity" } });
  assert.equal(resume.status, 206);
  assert.equal(resume.headers.get("content-range"), `bytes ${bytes.length - 1}-${bytes.length - 1}/${bytes.length}`);
  assert.deepEqual([...new Uint8Array(await resume.arrayBuffer())], [0x0a]);

  const middle = await get("/simple/dat/1795000000.dat", { headers: { Range: "bytes=10-", "Accept-Encoding": "identity" } });
  assert.equal(middle.status, 206);
  assert.deepEqual([...new Uint8Array(await middle.arrayBuffer())], [...bytes.slice(10)]);

  const beyond = await get("/simple/dat/1795000000.dat", { headers: { Range: `bytes=${bytes.length}-` } });
  assert.equal(beyond.status, 416);
  assert.equal(beyond.headers.get("content-range"), `bytes */${bytes.length}`);
});

test("実際の D1 で: あぼーん(UPDATE)で最終更新が進み、全件取得に反映される", async (t) => {
  if (skip) return t.skip(skip);
  const admin = readFileSync(path.join(root, "ADMIN.md"), "utf8");
  const abon = /```sql\n-- \[template:abon\]\n([\s\S]*?)```/.exec(admin)[1].replace("(no = 5)", "(no = 2)");
  const sqlFile = path.join(directory, "abon.sql");
  writeFileSync(sqlFile, abon);
  const before = await (await get("/api/v1/thread")).json();
  await new Promise((resolve) => setTimeout(resolve, 50));
  runWrangler(["d1", "execute", DB_NAME, "--config", path.join(directory, "wrangler.json"), "--local", "--persist-to", path.join(directory, "state"), "--file", sqlFile]);

  const after = await (await get("/api/v1/thread")).json();
  assert.ok(after.thread.updated_at > before.thread.updated_at);
  const raw = await decode(await get(`${READ}/?raw=0.0`));
  assert.ok(raw.includes("あぼーん<><>あぼーん<> あぼーん <>\n"));
  const diff = await decode(await get(`${READ}/?raw=2.0`));
  assert.equal(diff, "+OK 0/2048K\n", "差分取得(N が対象以降)には出ない");
});

// 連続投稿規制の状態(同じ ID)を使い切る前に実行する
test("実際のランタイムで: JSON API(認証・検証)", async (t) => {
  if (skip) return t.skip(skip);
  const unauthorized = await get("/api/v1/posts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "a" }) });
  assert.equal(unauthorized.status, 401);
  const validate = await get("/api/v1/posts/validate", {
    method: "POST", headers: { Authorization: "Bearer integration-token", "Content-Type": "application/json" },
    body: JSON.stringify({ name: "AI#t", message: " 検証 " }),
  });
  assert.equal(validate.status, 200);
  const body = await validate.json();
  assert.deepEqual(body.normalized, { name: "AI", mail: "", message: "検証" });
});

test("実際の D1 で: 同時投稿でも番号が連続し、連続投稿規制(直近 60 秒に 5 件)が原子的に効く", async (t) => {
  if (skip) return t.skip(skip);
  const before = (await (await get("/api/v1/thread")).json()).thread.post_count;
  // 同じ送信元(同じ ID)からの 10 件の同時投稿: 規制は直近 60 秒に 5 件まで。
  const responses = await Promise.all(Array.from({ length: 10 }, (_, i) => post({ MESSAGE: `concurrent ${i}` })));
  const statuses = responses.map((response) => response.status);
  const accepted = statuses.filter((status) => status === 303).length;
  const limited = statuses.filter((status) => status === 200 || status === 429).length;
  assert.equal(accepted + limited, 10, `想定外のステータス: ${statuses}`);
  assert.ok(accepted >= 1 && accepted <= 5, `受理 ${accepted} 件(同じ ID の既存の投稿を含めて 5 件まで)`);

  const after = await (await get("/api/v1/posts?limit=500")).json();
  const numbers = after.posts.map((entry) => entry.no);
  assert.deepEqual(numbers, Array.from({ length: numbers.length }, (_, i) => i + 1), "番号は連続している");
  assert.equal(numbers.length, before + accepted);
  const byId = Map.groupBy(after.posts.filter((entry) => entry.id !== ""), (entry) => entry.id);
  for (const [, entries] of byId) assert.ok(entries.length <= 5 + 1, "同じ ID は直近 60 秒に 5 件まで");
});
