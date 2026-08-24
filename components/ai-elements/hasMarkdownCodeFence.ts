const FENCE_RE = /(?:^|\n)\s{0,3}(`{3,}|~{3,})/;

/** True when markdown contains a fenced code block that may want Shiki. */
export function hasMarkdownCodeFence(text: string): boolean {
  return FENCE_RE.test(text);
}
