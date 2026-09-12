import katex, { type KatexOptions } from "katex";

export const NOTE_MATH_KATEX_OPTIONS: KatexOptions = Object.freeze({
  displayMode: true,
  output: "htmlAndMathml",
  throwOnError: false,
  strict: "warn",
  trust: false,
  maxExpand: 1_000,
  maxSize: 20,
});

export const normalizeNoteMathSource = (source: string): string => {
  const trimmed = source.trim();
  if (trimmed.length >= 4 && trimmed.startsWith("$$") && trimmed.endsWith("$$")) {
    return trimmed.slice(2, -2).trim();
  }
  if (trimmed.length >= 4 && trimmed.startsWith("\\[") && trimmed.endsWith("\\]")) {
    return trimmed.slice(2, -2).trim();
  }
  return trimmed;
};

export const renderNoteMathFormula = (source: string): string => katex.renderToString(
  normalizeNoteMathSource(source),
  NOTE_MATH_KATEX_OPTIONS,
);
