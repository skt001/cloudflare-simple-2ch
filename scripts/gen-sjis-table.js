import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const decoder = new TextDecoder("shift_jis", { fatal: false });
const table = new Map();
const duplicates = new Map();
const skipped = { replacement: 0, privateUse: 0, necSelectedIbm: 0 };

function consider(codePoint, code) {
  const list = duplicates.get(codePoint) ?? [];
  list.push(code);
  duplicates.set(codePoint, list);
  const current = table.get(codePoint);
  if (current === undefined || code < current) table.set(codePoint, code);
}

for (let byte = 0x00; byte <= 0x7f; byte++) consider(byte, byte);
for (let byte = 0xa1; byte <= 0xdf; byte++) {
  consider(decoder.decode(Uint8Array.of(byte)).codePointAt(0), byte);
}

for (let lead = 0x81; lead <= 0xfc; lead++) {
  if (lead > 0x9f && lead < 0xe0) continue;
  for (let trail = 0x40; trail <= 0xfc; trail++) {
    if (trail === 0x7f) continue;
    const text = decoder.decode(Uint8Array.of(lead, trail));
    const points = [...text];
    if (points.length !== 1) { skipped.replacement++; continue; }
    const codePoint = points[0].codePointAt(0);
    if (codePoint === 0xfffd) { skipped.replacement++; continue; }
    if (codePoint >= 0xe000 && codePoint <= 0xf8ff) { skipped.privateUse++; continue; }
    if (lead === 0xed || lead === 0xee) { skipped.necSelectedIbm++; continue; }
    consider(codePoint, (lead << 8) | trail);
  }
}

const extra = [
  [0x301c, 0x8160],
  [0x2016, 0x8161],
  [0x2212, 0x817c],
  [0x00a2, 0x8191],
  [0x00a3, 0x8192],
  [0x00ac, 0x81ca],
  [0x2014, 0x815c],
];
for (const [codePoint, code] of extra) {
  if (table.has(codePoint)) throw new Error(`追加分が既存と衝突: U+${codePoint.toString(16)}`);
  table.set(codePoint, code);
}

const entries = [...table].sort((a, b) => a[0] - b[0]);
const lines = [];
for (let i = 0; i < entries.length; i += 8) {
  lines.push("  " + entries.slice(i, i + 8).map(([cp, code]) => `${cp}: ${code},`).join(" "));
}
const output =
  "// 生成物。編集しないこと。`npm run gen:sjis`(scripts/gen-sjis-table.js)で再生成する。\n" +
  "// キーは Unicode のコードポイント、値は Shift_JIS のコード(1 バイトは 0x00〜0xFF、2 バイトは 0x8140〜)。\n" +
  "export const SJIS_TABLE = {\n" + lines.join("\n") + "\n};\n";
const target = fileURLToPath(new URL("../src/sjis-table.js", import.meta.url));
writeFileSync(target, output);

const multi = [...duplicates].filter(([, codes]) => codes.length > 1);
const byRange = new Map();
for (const [, codes] of multi) {
  const key = codes.map((code) => (code > 0xff ? (code >> 8).toString(16) : "1byte")).sort().join("+");
  byRange.set(key, (byRange.get(key) ?? 0) + 1);
}
console.log(`entries: ${entries.length} (extra ${extra.length})`);
console.log(`skipped: replacement=${skipped.replacement} privateUse=${skipped.privateUse} necSelectedIbm=${skipped.necSelectedIbm}`);
console.log(`duplicate characters: ${multi.length}`);
for (const [key, count] of [...byRange].sort()) console.log(`  lead bytes ${key}: ${count}`);
console.log(`wrote ${target}`);
