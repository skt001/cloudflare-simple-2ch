import assert from "node:assert/strict";
import test from "node:test";
import { SJIS_TABLE } from "../src/sjis-table.js";
import { decodeSjis, encodeSjis } from "../src/sjis.js";

const decoder = new TextDecoder("shift_jis");

// 復号側で別の文字になるため、追加で対応づけた 7 文字
const EXTRA = new Map([
  [0x301c, 0x8160], [0x2016, 0x8161], [0x2212, 0x817c], [0x00a2, 0x8191],
  [0x00a3, 0x8192], [0x00ac, 0x81ca], [0x2014, 0x815c],
]);

function bytesOfCode(code) {
  return code > 0xff ? Uint8Array.of(code >> 8, code & 0xff) : Uint8Array.of(code);
}

test("変換表の全エントリを TextDecoder で復号し直すと元の文字に一致する(追加の 7 文字を除く)", () => {
  let checked = 0;
  for (const [key, code] of Object.entries(SJIS_TABLE)) {
    const codePoint = Number(key);
    if (EXTRA.has(codePoint)) {
      assert.equal(code, EXTRA.get(codePoint));
      continue;
    }
    if (code < 0x80) {
      // ASCII は恒等(ICU の復号は一部の制御文字を入れ替えるため、復号との照合から除く)
      assert.equal(code, codePoint);
      continue;
    }
    assert.equal(decoder.decode(bytesOfCode(code)), String.fromCodePoint(codePoint), `U+${codePoint.toString(16)}`);
    checked++;
  }
  assert.ok(checked > 7000, `検証した件数: ${checked}`);
});

test("TextDecoder が復号できる文字は、すべて表にあり、同じ文字に戻る", () => {
  const targets = [];
  for (let byte = 0xa1; byte <= 0xdf; byte++) targets.push(Uint8Array.of(byte));
  for (let lead = 0x81; lead <= 0xfc; lead++) {
    if (lead > 0x9f && lead < 0xe0) continue;
    for (let trail = 0x40; trail <= 0xfc; trail++) if (trail !== 0x7f) targets.push(Uint8Array.of(lead, trail));
  }
  let covered = 0;
  for (const bytes of targets) {
    const text = decoder.decode(bytes);
    const points = [...text];
    if (points.length !== 1) continue;
    const codePoint = points[0].codePointAt(0);
    if (codePoint === 0xfffd || (codePoint >= 0xe000 && codePoint <= 0xf8ff)) continue;
    assert.equal(decoder.decode(encodeSjis(text)), text, `U+${codePoint.toString(16)}`);
    covered++;
  }
  assert.ok(covered > 7000);
});

test("追加の 7 文字は、対応するコードに変換される", () => {
  for (const [codePoint, code] of EXTRA) {
    assert.deepEqual([...encodeSjis(String.fromCodePoint(codePoint))], [...bytesOfCode(code)]);
  }
});

test("ASCII(制御文字を含む 0x00〜0x7F)は同じバイトに変換される", () => {
  for (let byte = 0x00; byte <= 0x7f; byte++) {
    assert.deepEqual([...encodeSjis(String.fromCharCode(byte))], [byte]);
  }
});

test("ASCII・半角カナ・全角・改行の変換", () => {
  assert.deepEqual([...encodeSjis("A\n")], [0x41, 0x0a]);
  assert.deepEqual([...encodeSjis("ｱ")], [0xb1]);
  assert.deepEqual([...encodeSjis("あ")], [0x82, 0xa0]);
  assert.deepEqual([...encodeSjis("名無しさん")], [0x96, 0xbc, 0x96, 0xb3, 0x82, 0xb5, 0x82, 0xb3, 0x82, 0xf1]);
});

test("変換不能な文字は数値文字参照になる(サロゲートペアは 1 コードポイント)", () => {
  const ascii = (text) => String.fromCharCode(...encodeSjis(text));
  assert.equal(ascii("😀"), "&#128512;");
  assert.equal(ascii("a😀b"), "a&#128512;b");
  assert.equal(ascii("\u00e9"), "&#233;");
  assert.equal(ascii("\u00a5"), "&#165;");
});

test("NEC 選定 IBM 拡張は使わず、重複する文字は小さい方のコードにする", () => {
  assert.deepEqual([...encodeSjis("\u2252")], [0x81, 0xe0]); // ≒(NEC 行 13 の 0x8790 より小さい)
  assert.deepEqual([...encodeSjis("\u7e8a")], [0xfa, 0x5c]); // 纊(0xED40 台ではなく IBM 拡張)
  assert.deepEqual([...encodeSjis("\uffe2")], [0x81, 0xca]);
});

test("長い文字列でも欠けずに変換できる", () => {
  const text = "あ😀".repeat(5000);
  const bytes = encodeSjis(text);
  assert.equal(bytes.length, 5000 * (2 + "&#128512;".length));
});

test("decodeSjis: encodeSjis と往復できる", () => {
  for (const text of ["専用ブラウザからの書き込み", "半角ｶﾀｶﾅと全角カタカナ", "ABCabc123 !~", "あぼーん"]) {
    assert.equal(decodeSjis(encodeSjis(text)), text);
  }
});
