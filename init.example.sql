INSERT INTO thread (id, title, created_at, modified_at)
VALUES (
  1,
  'Simple 2ch like one thread BBS',
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
  'https://github.com/skt001/cloudflare-simple-2ch をご覧ください',
  CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4) AS INTEGER),
  'web'
);
