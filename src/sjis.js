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
