# 運用ガイド

管理画面と管理用エンドポイントはありません。D1 に SQL を直接実行して運用します(`cloudflare-simple-uploader` の ADMIN.md と同じ方針)。バイト数を保持しないため、運用にスクリプトは要りません。

## 1. 実行方法

データベース名は `simple-2ch-db`(`wrangler.jsonc` の `database_name`)です。すべての SQL に、実行先を `--remote`(本番)か `--local`(開発)で必ず明記します。

```sh
# 1 文を実行する
npx wrangler d1 execute simple-2ch-db --remote --command "SELECT COUNT(*) AS n FROM posts"

# SQL ファイルを実行する(複数の文、改行を含む本文はこちら)
npx wrangler d1 execute simple-2ch-db --remote --file ./init.sql
```

`--local` は `npm run dev` が使う開発用のデータベースです。本番には影響しません。

## 2. 初期設定

```sh
cp wrangler.example.jsonc wrangler.jsonc          # wrangler.jsonc は .gitignore 済み
npx wrangler d1 create simple-2ch-db              # 出力された database_id を wrangler.jsonc に書く
npm run db:apply:remote                           # migrations を適用する(開発用は db:apply:local)
npx wrangler secret put ID_SEED                   # ID の種。長いランダムな文字列
npx wrangler secret put API_POST_TOKEN            # JSON API の投稿用トークン(API を使うときだけ)
npm run deploy
```

- 開発用の secret は `.dev.vars`(`.gitignore` 済み)に `ID_SEED=...`、`API_POST_TOKEN=...` と書きます。
- `ID_SEED` が未設定だと、投稿(HTML・JSON)は 500 で拒否されます。閲覧は使えます。
- `ID_SEED` を変えると、以降の投稿の ID が変わります。過去の投稿は保存済みの文字列のままです。
- `API_POST_TOKEN` が未設定だと、JSON API の投稿系は 503 `API_DISABLED` になります。読み取りは使えます。
- bbs・key・レス数の上限(`MAX_POSTS`)などの定数は `src/config.js` にあります。変更したら再デプロイします。key を変えると URL が変わるため、専用ブラウザの登録は別のスレッドとして扱われます。

## 3. 初期スレッドの作成

スレッドを作る機能はアプリにありません。次の雛形の値を書き換えて `--file` で実行します。1 番のレスにスレッドタイトルが付きます。`thread` は 1 行だけで、初期化後にタイトルは変えません。

書き換える値:

- タイトル、名前、メール、本文は**エスケープ済みの値**で書きます: `&` → `&amp;`、`<` → `&lt;`、`>` → `&gt;`(メールは `"` → `&quot;` も)。SQL の文字列中の `'` は `''` と書きます。
- 本文の改行は、文字列の中にそのまま改行を書きます(`<br>` は書きません)。
- 日付は、JST の `YYYY/MM/DD(曜) HH:MM:SS` を手で書きます(曜日は 日月火水木金土)。
- `poster_id` は 8 文字の任意の文字列です(投稿者の ID として表示されます)。

```sql
-- [template:init]
INSERT INTO thread (id, title, created_at, modified_at)
VALUES (
  1,
  'スレッドのタイトル',
  CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4) AS INTEGER),
  CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4) AS INTEGER)
);

INSERT INTO posts (no, name, mail, date_text, poster_id, message, posted_at, source)
VALUES (
  1,
  '名無しさん',
  '',
  '2026/11/19(木) 12:00:00',
  'Admin001',
  '最初のレスの本文です。',
  CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4) AS INTEGER),
  'web'
);
```

`thread.modified_at`(最終更新)は、1 番の追加でトリガーが現在時刻に更新します。実行後は `GET /api/v1/thread` か HTML の表示で確認します。

## 4. あぼーん

投稿の削除ではなく、**値の書き換え**で行います(物理削除はしません。番号に欠番ができ、取得済みのクライアントとの整合が崩れるため)。通常の投稿と区別する状態やフラグは持ちません。書き換えた行は、HTML・dat・JSON のすべてで通常の投稿として出力されます。

1. **実行前に、同じ `WHERE` で `SELECT` して対象を確認し、元の内容を控えます。** 元の本文は残りません。
2. `UPDATE` の `WHERE` を書き換えて実行します。**`WHERE` のない `UPDATE` は実行しません。**
3. 1 番(スレッドタイトルを含む行)は対象外です。`WHERE` に `no >= 2` を必ず入れます。

```sql
-- [template:select-before-abon]
SELECT no, name, mail, date_text, poster_id, message
FROM posts
WHERE no >= 2 AND (no = 5);
```

```sql
-- [template:abon]
UPDATE posts
SET name = 'あぼーん', mail = '', date_text = 'あぼーん', poster_id = '', message = 'あぼーん'
WHERE no >= 2 AND (no = 5);
```

範囲は `WHERE no >= 2 AND (no BETWEEN 10 AND 12)`、特定の ID の投稿をまとめてなら `WHERE no >= 2 AND (poster_id = 'xxxxxxxx')` のように、括弧の中を書き換えます。更新時刻は書きません。`UPDATE` をトリガーが検知して、`thread.modified_at` が更新されます。

反映のされ方:

- 全件取得・範囲取得(HTML、dat の全体、raw の全件・部分、JSON)には、書き換え後の値が出ます。`Last-Modified` が更新されるため、全件取得の 304 は返りません。
- 取得済みのクライアントには反映されません。差分取得は番号だけで行うためです(あぼーんの番号が取得済みの位置より前のとき)。
- dat の直接取得(Range)で、あぼーんにより行のバイト数が変わると、専用ブラウザが持つ位置と行末がずれます。専用ブラウザは、続きの先頭が改行でないことを検出して、全体を取り直します(既知の制約です)。
- `poster_id` を空にすると、その投稿は連続投稿規制の件数から外れます。

## 5. 状況の確認

```sql
-- スレッドの状態(modified_at は UTC ミリ秒)
SELECT title, datetime(created_at / 1000, 'unixepoch') AS created_utc,
       datetime(modified_at / 1000, 'unixepoch') AS modified_utc
FROM thread;

-- レス数と最新番号(欠番がなければ同じ値)
SELECT COUNT(*) AS count, MAX(no) AS latest FROM posts;

-- 最新の投稿 10 件(source は web または api)
SELECT no, name, date_text, poster_id, source, substr(message, 1, 40) AS message
FROM posts ORDER BY no DESC LIMIT 10;

-- 直近 60 秒の投稿数が多い ID(連続投稿規制の様子)
SELECT poster_id, COUNT(*) AS n
FROM posts
WHERE posted_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 60000 AND poster_id <> ''
GROUP BY poster_id ORDER BY n DESC;
```

レス数が `MAX_POSTS`(既定 5000)に達すると、投稿は拒否されます(HTML は 409、JSON は `THREAD_FULL`)。上限を上げるときは `src/config.js` の `MAX_POSTS` を変えて再デプロイします。

## 6. 整合性

- 番号は 1 から連続します。`SELECT COUNT(*), MAX(no) FROM posts` の 2 つの値が一致しないときは、欠番があります(物理削除をしていないか確認します)。
- `thread` は `id = 1` の 1 行だけです(制約で固定)。1 番のレスがない、または `thread` の行がないと、閲覧・取得は「そんな板orスレッドないです。」になります。
- 最終更新は、`posts` の追加・更新のたびにトリガーが `thread.modified_at` に書きます。アプリと運用の SQL では書きません。
- `dat_lines` は `posts` から生成する dat のキャッシュです。正本ではありません。内容が食い違う行は、アプリが dat の読み取り時に検出して作り直します。すべて消しても、次回の dat 取得で再生成されます。

## 7. バックアップと復旧

```sh
npx wrangler d1 export simple-2ch-db --remote --output ./backup.sql
```

- あぼーんの前に控えた内容は、元の行を `UPDATE` で書き戻して復元できます(`date_text` は書き込み時に確定した文字列、`poster_id` は元の ID)。
- D1 の Time Travel(`npx wrangler d1 time-travel info simple-2ch-db`)で、過去の時点に戻す方法もあります。詳細は Cloudflare のドキュメントを参照してください。

## 8. 公開運用の補足

- 通常ブラウザの投稿に認証はありません。荒らし対策は、フォームの `time` の検証と、連続投稿規制(同じ ID で直近 60 秒に 5 件以上なら拒否)です。
- 連続投稿規制は、送信元の IP と JST の日付から作る ID で数えます。日付をまたぐ 60 秒では ID が変わるため、規制が効きません。
- IP アドレスは保存しません。ID は `ID_SEED` を鍵とした HMAC で、IP を復元できません。
