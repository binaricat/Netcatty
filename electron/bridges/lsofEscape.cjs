/**
 * Decode the byte escapes lsof emits for `-F n` name fields.
 *
 * lsof prints non-printable and non-ASCII bytes as \xHH, uses C escapes such
 * as \n and \t, and doubles a literal backslash. Its caret form is ambiguous
 * (a BEL byte and the literal characters "^G" produce the same output), so
 * callers must not navigate to a path it could have produced.
 */
function decodeLsofFileName(value) {
  if (typeof value !== 'string') return null;
  if (/\^[\x40-\x5f?]/.test(value)) return null;
  const bytes = [];
  const simpleEscapes = {
    b: 0x08,
    f: 0x0c,
    n: 0x0a,
    r: 0x0d,
    t: 0x09,
    v: 0x0b,
    '\\': 0x5c,
  };

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== '\\') {
      bytes.push(...Buffer.from(char));
      continue;
    }
    const escaped = value[index + 1];
    if (!escaped) return null;
    if (Object.prototype.hasOwnProperty.call(simpleEscapes, escaped)) {
      bytes.push(simpleEscapes[escaped]);
      index += 1;
      continue;
    }
    if (escaped === 'x') {
      const hex = value.slice(index + 2, index + 4);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
      bytes.push(Number.parseInt(hex, 16));
      index += 3;
      continue;
    }
    const octal = value.slice(index + 1).match(/^[0-7]{1,3}/)?.[0];
    if (octal) {
      bytes.push(Number.parseInt(octal, 8));
      index += octal.length;
      continue;
    }
    return null;
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}

module.exports = { decodeLsofFileName };
