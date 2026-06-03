/**
 * Terminal encoding helpers — the single source of truth for turning a
 * user-facing charset name into an iconv-lite identifier and for keeping the
 * terminal input (keystrokes → remote) and output (remote → display) paths on
 * the *same* encoding.
 *
 * Background (issue #1216): the output path already decodes remote bytes with
 * an iconv decoder built from the user's configured charset (GB18030, etc.),
 * but the input path used to serialize keystrokes as UTF-8 unconditionally.
 * On a non-UTF-8 device that made input and output asymmetric — typing Chinese
 * showed up garbled on the device while the device's own output decoded fine
 * (or vice-versa, depending on which side the user matched). Encoding input
 * with the *same* charset closes that gap.
 */

const iconv = require("iconv-lite");

// Normalize user-facing charset names into an iconv-lite encoding identifier.
// iconv-lite accepts a wide range of aliases directly ("utf-8", "gbk", etc.),
// so mostly this just lowercases + collapses non-alphanumerics and maps a few
// obvious GB* variants to gb18030 which is the superset we ship the encoding
// switcher with. Anything iconv doesn't recognize falls back to utf-8.
function normalizeTerminalEncoding(charset) {
  if (!charset) return "utf-8";
  const raw = String(charset).trim().toLowerCase();
  const normalized = raw.replace(/[^a-z0-9]/g, "");
  if (["utf8", "utf-8"].includes(normalized)) return "utf-8";
  if (normalized === "gb18030" || normalized === "gbk" || normalized === "gb2312") return "gb18030";
  return iconv.encodingExists(raw) ? raw : "utf-8";
}

// True when the encoding is UTF-8 (the JS/Node default for string → bytes).
// Callers use this to skip the iconv round-trip on the hot input path: for
// UTF-8 the platform's native string serialization is already correct, so
// there is nothing to convert.
function isUtf8Encoding(encoding) {
  if (!encoding) return true;
  return /^utf-?8$/i.test(String(encoding).trim());
}

// Cache of encoding identifier -> whether it is ASCII-compatible (each ASCII
// byte encodes to exactly itself, one byte). iconv probing is cheap but this is
// the keystroke hot path, so memoize it.
const asciiCompatibleCache = new Map();

// A terminal speaks ASCII control bytes: CR, LF, ESC and the bytes of CSI
// escape sequences (Enter, arrows, Ctrl-C, …). Encodings like GB18030 / GBK /
// Big5 / Shift_JIS / EUC / latin1 are ASCII supersets, so those bytes survive
// untouched and only the non-ASCII characters change. But ASCII-incompatible
// multi-byte encodings (UTF-16LE/BE, UCS-2, UTF-32, …) would turn "\r" into
// `0d 00` and "\x1b[A" into `1b 00 5b 00 41 00`, breaking line discipline and
// escape parsing on the remote. We probe a representative ASCII control byte
// and refuse to use iconv for input on encodings that don't preserve it.
function isAsciiCompatibleEncoding(encoding) {
  const cached = asciiCompatibleCache.get(encoding);
  if (cached !== undefined) return cached;
  let compatible = false;
  try {
    // \r and ESC cover the control bytes we care about; a single C0 probe is
    // enough since ASCII-incompatible encodings widen every code point.
    const cr = iconv.encode("\r", encoding);
    const esc = iconv.encode("\x1b", encoding);
    compatible = cr.length === 1 && cr[0] === 0x0d && esc.length === 1 && esc[0] === 0x1b;
  } catch {
    compatible = false;
  }
  asciiCompatibleCache.set(encoding, compatible);
  return compatible;
}

/**
 * Encode a terminal input string for the wire using the session's charset.
 *
 * Returns the original string unchanged for UTF-8 (let the transport's native
 * string handling serialize it) and a Buffer encoded with iconv-lite for any
 * other ASCII-compatible charset. ASCII control bytes (CR, ESC, Ctrl-C, the
 * bytes of CSI escape sequences, …) stay single-byte under those encodings, so
 * encoding the whole string is safe — only the non-ASCII characters change.
 *
 * `encoding` is expected to already be a normalized iconv identifier (what
 * normalizeTerminalEncoding returns and what sessions store on
 * `session.encoding`). Falls back to the UTF-8 string — i.e. today's behavior —
 * for unknown encodings and for ASCII-incompatible ones (UTF-16/UCS-2/…) where
 * widening the control bytes would break Enter / arrows / Ctrl-C on the remote.
 */
function encodeTerminalInput(data, encoding) {
  if (typeof data !== "string") return data;
  if (isUtf8Encoding(encoding)) return data;
  if (!iconv.encodingExists(encoding)) return data;
  if (!isAsciiCompatibleEncoding(encoding)) return data;
  return iconv.encode(data, encoding);
}

module.exports = {
  normalizeTerminalEncoding,
  isUtf8Encoding,
  encodeTerminalInput,
};
