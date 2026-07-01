export function forEachNonEmptyRegexMatch(
  regex: RegExp,
  text: string,
  onMatch: (match: RegExpExecArray) => void,
) {
  regex.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match[0].length === 0) {
      if (regex.lastIndex <= match.index) {
        // Advance past the full code point to avoid landing inside a surrogate pair
        const code = text.charCodeAt(match.index);
        regex.lastIndex = match.index + (code >= 0xD800 && code <= 0xDBFF ? 2 : 1);
      }
      if (regex.lastIndex > text.length) {
        break;
      }
      continue;
    }

    onMatch(match);
  }
}
