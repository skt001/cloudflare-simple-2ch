import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import { call, fillPosts, makeEnv, readBase, seedMinimal, seedSample } from "./helpers.js";

afterEach(() => mock.restoreAll());

const NOW = 1_763_477_159_500;
const SAMPLE_HTML = `<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
<title>サンプルスレッド </title>
</head>
<body bgcolor=#efefef text=black link=blue alink=red vlink=#660099>
<a href="/sample/">■掲示板に戻る■</a> <a href=/test/read.cgi/sample/1731898801/>レスを全部読む</a> <a href=/test/read.cgi/sample/1731898801/1-100>1-</a> <a href=/test/read.cgi/sample/1731898801/l50>最新レス50</a>
<p><font size=+1 color=red>サンプルスレッド </font>
<dl>
<dt>1 名前：<font color=green><b>名無しさん </b></font>投稿日：2026/11/18(水) 09:00:01 ID:Ab3dEf9G<dd> テスト用スレッドです。ダミーデータなので自由に眺めてください。 <br><br>
<dt>2 名前：<font color=blue><b>名無しさん </b></font>投稿日：2026/11/18(水) 09:01:12 ID:Hj7kLm2N<dd> 2get <br> 改行も確認できます。 <br><br>
<dt>3 名前：<font color=blue><b>テスト太郎 </b></font>投稿日：2026/11/18(水) 09:03:45 ID:Pq4rSt6U<dd> <a href="/test/read.cgi/sample/1731898801/1" target="_blank">&gt;&gt;1</a> <br> スレ立て乙です。 <br><br>
<dt>4 名前：<font color=green><b>名無しさん </b></font>投稿日：2026/11/18(水) 09:05:20 ID:Vw8xYz1A<dd> <a href="/test/read.cgi/sample/1731898801/2-3" target="_blank">&gt;&gt;2-3</a> <br> まとめてアンカーのテストです。 <br><br>
<dt>5 名前：<font color=blue><b>名無しさん </b></font>投稿日：2026/11/18(水) 09:10:00 ID:Bc5dEf2G<dd> 山括弧のエスケープ確認: &lt;b&gt;太字ではありません&lt;/b&gt; <br><br>
<dt>6 名前：<font color=green><b>名無しさん </b></font>投稿日：2026/11/18(水) 10:15:33 ID:Hi6jKl3M<dd> 絵文字は &#128512; のように数値文字参照になります。 <br><br>
<dt>7 名前：<font color=blue><b>名前欄あり ◆TestTrip </b></font>投稿日：2026/11/18(水) 11:20:48 ID:No7pQr4S<dd> 名前欄にトリップ風の表示がある例です。 <br><br>
<dt>8 名前：<font color=green><b>名無しさん </b></font>投稿日：2026/11/18(水) 12:00:00 ID:Tu8vWx5Y<dd> 長い行の折り返し確認: あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん <br><br>
<dt>9 名前：<font color=blue><b>名無しさん </b></font>投稿日：2026/11/18(水) 13:30:12 ID:Za9bCd6E<dd> <a href="/test/read.cgi/sample/1731898801/5" target="_blank">&gt;&gt;5</a> <br> sage なので名前が青で表示される確認です。 <br><br>
<dt>10 名前：<font color=green><b>名無しさん </b></font>投稿日：2026/11/18(水) 14:45:59 ID:Fg1hIj7K<dd> 最新レスのサンプルです。 <br><br>
</dl>
<hr><center><a href=/test/read.cgi/sample/1731898801/10->新着レスの表示</a></center>
<form method=POST action="/test/bbs.cgi"><input type=submit value="書き込む" name=submit> 名前： <input name=FROM size=19> E-mail<font size=1> (省略可) </font>: <input name=mail size=19><br><textarea rows=5 cols=70 wrap=off name=MESSAGE></textarea><input type=hidden name=bbs value=sample><input type=hidden name=key value=1731898801><input type=hidden name=time value=1763477159></form>
<p>
</body></html>
`;

function sampleEnv() {
  const env = makeEnv();
  seedSample(env);
  return env;
}

async function html(env, path) {
  const response = await call(env, path);
  return { response, text: await response.text() };
}

function numbersIn(text) {
  return [...text.matchAll(/<dt>(\d+) /g)].map((match) => Number(match[1]));
}

test("サンプルと同じ構造で出力する(bbs・key・時刻・9 番の文言・絵文字の表記だけを置き換えて完全一致)", async () => {
  mock.method(Date, "now", () => NOW);
  const env = sampleEnv();
  const { response, text } = await html(env, `${readBase}/`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/html; charset=UTF-8");
  assert.equal(response.headers.get("Cache-Control"), "no-store");

  const expected = SAMPLE_HTML
    .replaceAll("/sample/", "/simple/")
    .replaceAll("1731898801", "1795000000")
    .replace("value=sample>", "value=simple>")
    .replace("sage なので名前が青で表示される確認です。", "sage なので名前が太字にならない表示の確認です。")
    // HTML は UTF-8 のため、絵文字は数値文字参照にせずそのまま出す(dat だけが数値文字参照にする)
    .replace("&#128512;", "😀");
  assert.equal(text, expected);
});

test("範囲なし・末尾の / なし・クエリ形式は同じ応答", async () => {
  mock.method(Date, "now", () => NOW);
  const env = sampleEnv();
  const base = (await html(env, `${readBase}/`)).text;
  for (const path of [
    readBase,
    `/test/read.cgi?bbs=simple&key=1795000000`,
    `${readBase}/?raw=`,
  ]) {
    assert.equal((await html(env, path)).text, base, path);
  }
});

test("レス範囲: n / n- / -m / n-m / lN と nofirst", async () => {
  const env = sampleEnv();
  const cases = [
    ["5", [5]], // n 番だけ(1 を付け足さない)
    ["5-", [1, 5, 6, 7, 8, 9, 10]], // 1 番を先頭に付ける
    ["-3", [1, 2, 3]],
    ["2-4", [1, 2, 3, 4]],
    ["1-3", [1, 2, 3]],
    ["l3", [1, 9, 10]], // 1 番 + 最新 2 件で計 3 件
    ["l1", [10]], // 最新 1 件だけ
    ["l50", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]],
    ["n", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]],
    ["99", [10]], // 最終レスに丸める
    ["99-", [1, 10]],
    ["4-2", [1, 4]], // first > last のとき last = first
    ["i", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]], // 対象外の書式は範囲なし
  ];
  for (const [range, expected] of cases) {
    const { response, text } = await html(env, `${readBase}/${range}`);
    assert.equal(response.status, 200, range);
    assert.deepEqual(numbersIn(text), expected, range);
  }
  assert.deepEqual(numbersIn((await html(env, `${readBase}/l3`)).text), [1, 9, 10]);
});

test("レス範囲: クエリ形式の st / to / ls / nofirst(ls が優先)", async () => {
  const env = sampleEnv();
  const q = (query) => html(env, `/test/read.cgi?bbs=simple&key=1795000000&${query}`);
  assert.deepEqual(numbersIn((await q("st=3&to=4")).text), [1, 3, 4]);
  assert.deepEqual(numbersIn((await q("st=3&to=4&nofirst=true")).text), [3, 4]);
  assert.deepEqual(numbersIn((await q("ls=2")).text), [1, 10]);
  assert.deepEqual(numbersIn((await q("ls=2&nofirst=true")).text), [9, 10]);
  assert.deepEqual(numbersIn((await q("st=2&to=3&ls=1")).text), [10]);
  assert.deepEqual(numbersIn((await q("st=-3")).text), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("アンカー: 有効な範囲だけリンクにし、無効なものは文字のまま", async () => {
  const env = sampleEnv();
  const insert = env.simple_2ch_db.sqlite.prepare(
    "INSERT INTO posts VALUES (?, '名無しさん', '', 'd', 'i', ?, 0, 'web')"
  );
  insert.run(11, "&gt;&gt;99 &gt;&gt;0 &gt;&gt;3-2 &gt;&gt;1-5 &gt;&gt;10-99 &amp;gt;&amp;gt;1");
  const { text } = await html(env, `${readBase}/11`);
  const body = text.split("<dd>")[1];
  assert.ok(body.includes("&gt;&gt;99 &gt;&gt;0 &gt;&gt;3-2 "), "無効なアンカーは文字のまま");
  assert.ok(body.includes('<a href="/test/read.cgi/simple/1795000000/1-5" target="_blank">&gt;&gt;1-5</a>'));
  assert.ok(body.includes('<a href="/test/read.cgi/simple/1795000000/10-11" target="_blank">&gt;&gt;10-99</a>'));
  assert.ok(body.includes("&amp;gt;&amp;gt;1"), "利用者が書いた &gt; の文字列はリンクにしない");

  const single = (await html(env, `${readBase}/3`)).text;
  assert.ok(single.includes('<a href="/test/read.cgi/simple/1795000000/1" target="_blank">&gt;&gt;1</a>'));
});

test("名前の色とメール: 通常は green、sage は blue、sage 以外のメールは名前を mailto でリンクする", async () => {
  const env = sampleEnv();
  const insert = env.simple_2ch_db.sqlite.prepare("INSERT INTO posts VALUES (?, 'n', ?, 'd', 'i', 'm', 0, 'web')");
  insert.run(11, "a@example.com");
  insert.run(12, "SAGE");
  insert.run(13, "&quot;x&quot;");
  const { text } = await html(env, `${readBase}/11-13`);
  assert.ok(text.includes('名前：<a href="mailto:a@example.com"><font color=green><b>n </b></font></a>'));
  assert.ok(text.includes("12 名前：<font color=blue><b>n </b></font>"));
  assert.ok(text.includes('<a href="mailto:&quot;x&quot;"><font color=green>'));
});

test("あぼーんした行は、書き換え後の値を通常の投稿として出力する", async () => {
  const env = sampleEnv();
  env.simple_2ch_db.exec("UPDATE posts SET name = 'あぼーん', mail = '', date_text = 'あぼーん', poster_id = '', message = 'あぼーん' WHERE no = 4");
  const { text } = await html(env, `${readBase}/4`);
  assert.ok(text.includes("<dt>4 名前：<font color=green><b>あぼーん </b></font>投稿日：あぼーん<dd> あぼーん <br><br>"));
});

test("ナビゲーション: 100 件単位のチャンク、前100・次100(範囲が先頭でも末尾でもないときだけ)", async () => {
  const env = sampleEnv();
  fillPosts(env, 11, 1200);
  const top = (await html(env, `${readBase}/l50`)).text;
  const chunks = [...top.matchAll(/<a href=\/test\/read\.cgi\/simple\/1795000000\/(\d+)-(\d+)>(\d+)-<\/a>/g)];
  assert.equal(chunks.length, 12);
  assert.deepEqual([chunks[0][1], chunks[0][2], chunks[0][3]], ["1", "100", "1"]);
  assert.deepEqual([chunks[11][1], chunks[11][2], chunks[11][3]], ["1101", "1200", "1101"]);
  assert.ok(!top.includes("前100"), "末尾の範囲では出さない");

  const middle = (await html(env, `${readBase}/101-200`)).text;
  assert.ok(middle.includes("<a href=/test/read.cgi/simple/1795000000/1-100>前100</a>"));
  assert.ok(middle.includes("<a href=/test/read.cgi/simple/1795000000/201-300>次100</a>"));

  const first = (await html(env, `${readBase}/1-100`)).text;
  assert.ok(!first.includes("前100") && !first.includes("次100"));
  assert.ok(first.includes("最新レス50"));
});

test("1 回の表示は 1000 件で打ち切り、次の範囲へのリンクを出す(付け足す 1 番も件数に含める)", async () => {
  const env = sampleEnv();
  fillPosts(env, 11, 1200);
  const all = await html(env, `${readBase}/`);
  assert.equal(numbersIn(all.text).length, 1000);
  assert.deepEqual([numbersIn(all.text)[0], numbersIn(all.text)[999]], [1, 1000]);
  assert.ok(all.text.includes("<a href=/test/read.cgi/simple/1795000000/1001->続きを読む</a>"));
  assert.ok(!all.text.includes("新着レスの表示"), "最後のレスが範囲に含まれないときは出さない");

  const prepended = numbersIn((await html(env, `${readBase}/5-`)).text);
  assert.equal(prepended.length, 1000);
  assert.deepEqual([prepended[0], prepended[1], prepended[999]], [1, 5, 1003]);

  const tail = (await html(env, `${readBase}/1001-`)).text;
  assert.ok(!tail.includes("続きを読む"));
  assert.ok(tail.includes("新着レスの表示"));
});

test("新着レスの表示: 最後のレスが範囲に含まれるときだけ、最終レス番号以降へのリンク", async () => {
  const env = sampleEnv();
  assert.ok((await html(env, `${readBase}/l5`)).text.includes("<center><a href=/test/read.cgi/simple/1795000000/10->新着レスの表示</a></center>"));
  assert.ok(!(await html(env, `${readBase}/1-5`)).text.includes("新着レスの表示"));
});

test("フォーム: hidden の bbs・key・time と、入力項目", async () => {
  mock.method(Date, "now", () => 1_795_000_123_456);
  const env = sampleEnv();
  const { text } = await html(env, `${readBase}/`);
  assert.ok(text.includes('<form method=POST action="/test/bbs.cgi">'));
  assert.ok(text.includes("<input type=hidden name=bbs value=simple><input type=hidden name=key value=1795000000><input type=hidden name=time value=1795000123>"));
  assert.ok(text.includes("name=FROM size=19") && text.includes("name=mail size=19"));
  assert.ok(text.includes("<textarea rows=5 cols=70 wrap=off name=MESSAGE></textarea>"));
  assert.ok(!/accept-charset/i.test(text));
});

test("警告帯 3 段階(MAX_POSTS の 90% / 95% / 100%)と書き込み停止時のフォーム非表示", async () => {
  const env = makeEnv();
  seedMinimal(env);
  const band = (text) => /<table border=1 cellspacing=7 cellpadding=3 width=95% bgcolor=([^ ]+) align=center><tr><td>([^<]*)<\/td><\/tr><\/table>/.exec(text);

  fillPosts(env, 2, 4500);
  assert.equal(band((await html(env, `${readBase}/l1`)).text), null, "4500 件(90% ちょうど)では出ない");

  fillPosts(env, 4501, 4501);
  let result = band((await html(env, `${readBase}/l1`)).text);
  assert.deepEqual([result[1], result[2]], ["yellow", "レスが 4500 件を超えました(上限 5000 件)"]);

  fillPosts(env, 4502, 4750);
  result = band((await html(env, `${readBase}/l1`)).text);
  assert.equal(result[1], "yellow", "4750 件(95% ちょうど)は黄色のまま");

  fillPosts(env, 4751, 4999);
  const nearly = await html(env, `${readBase}/l1`);
  result = band(nearly.text);
  assert.deepEqual([result[1], result[2]], ["#ff6633", "まもなく書き込めなくなります(上限 5000 件)"]);
  assert.ok(nearly.text.includes("<form "), "上限の手前ではフォームを出す");
  assert.ok(nearly.text.indexOf("</dl>") < nearly.text.indexOf("<table border=1") && nearly.text.indexOf("<table border=1") < nearly.text.indexOf("<hr>"));

  fillPosts(env, 5000, 5000);
  const full = await html(env, `${readBase}/l1`);
  result = band(full.text);
  assert.deepEqual([result[1], result[2]], ["red", "レス数の上限に達したため書き込めません"]);
  assert.ok(!full.text.includes("<form ") && !full.text.includes("新着レスの表示"));
});

test("板・スレッドが違う、またはスレッドがないときは 404 のエラーページ", async () => {
  const env = sampleEnv();
  for (const path of [`/test/read.cgi/other/1795000000/`, `/test/read.cgi/simple/1234567890/l50`]) {
    const { response, text } = await html(env, path);
    assert.equal(response.status, 404, path);
    assert.ok(text.includes("<title>ＥＲＲＯＲ！</title>"));
    assert.ok(text.includes("<b>ＥＲＲＯＲ：そんな板orスレッドないです。</b>"));
  }
  assert.equal((await html(makeEnv(), `${readBase}/`)).response.status, 404);
});

test("HEAD は GET と同じステータス・ヘッダーで本文なし", async () => {
  const env = sampleEnv();
  const head = await call(env, `${readBase}/`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("Content-Type"), "text/html; charset=UTF-8");
  assert.equal(await head.text(), "");
});

test("ルーティング: / と /{bbs}/ は最新 50 件へ 302、256 文字以上のパス・未知のパスは 404", async () => {
  const env = sampleEnv();
  for (const path of ["/", "/simple/"]) {
    const response = await call(env, path);
    assert.equal(response.status, 302, path);
    assert.equal(response.headers.get("Location"), `${readBase}/l50`);
  }
  assert.equal((await call(env, "/other/")).status, 404);
  assert.equal((await call(env, `/test/read.cgi/simple/1795000000/${"1".repeat(250)}`)).status, 404);
  assert.equal((await call(env, `/${"a".repeat(260)}`)).status, 404);
  assert.equal((await call(env, `${readBase}/1/2/3`)).status, 404);
  assert.equal((await call(env, "/test/bbs.cgi")).status, 404);
  assert.equal((await call(env, "/subject.txt")).status, 404);
  const wrongMethod = await call(env, `${readBase}/`, { method: "DELETE" });
  assert.equal(wrongMethod.status, 404);
});
