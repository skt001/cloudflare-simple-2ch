import { SJIS_TABLE } from "./sjis-table.js";

export function encodeSjis(text) {
  let out = new Uint8Array(text.length * 2 + 16);
  let length = 0;

  function ensure(extra) {
    if (length + extra <= out.length) return;
    const next = new Uint8Array(Math.max(out.length * 2, length + extra));
    next.set(out.subarray(0, length));
    out = next;
  }

  for (const character of text) {
    const codePoint = character.codePointAt(0);
    const code = SJIS_TABLE[codePoint];
    ensure(10);
    if (code === undefined) {
      const reference = `&#${codePoint};`;
      for (let i = 0; i < reference.length; i++) out[length++] = reference.charCodeAt(i);
    } else if (code > 0xff) {
      out[length++] = code >> 8;
      out[length++] = code & 0xff;
    } else {
      out[length++] = code;
    }
  }
  return out.slice(0, length);
}

export function concatBytes(parts) {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

let decodeTable = null;

function buildDecodeTable() {
  const table = new Map();
  const entries = Object.entries(SJIS_TABLE)
    .map(([codePoint, code]) => [Number(codePoint), code])
    .sort((a, b) => a[0] - b[0]);
  for (const [codePoint, code] of entries) {
    if (!table.has(code)) table.set(code, codePoint);
  }
  return table;
}

export function decodeSjis(bytes) {
  if (!decodeTable) decodeTable = buildDecodeTable();
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    const isLead = (byte >= 0x81 && byte <= 0x9f) || (byte >= 0xe0 && byte <= 0xfc);
    if (!isLead) {
      out += String.fromCodePoint(decodeTable.get(byte) ?? 0xfffd);
      continue;
    }
    const trail = bytes[i + 1];
    const isTrail = trail !== undefined &&
      ((trail >= 0x40 && trail <= 0x7e) || (trail >= 0x80 && trail <= 0xfc));
    if (!isTrail) {
      out += "\ufffd";
      continue;
    }
    out += String.fromCodePoint(decodeTable.get((byte << 8) | trail) ?? 0xfffd);
    i++;
  }
  return out;
}
