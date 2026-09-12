import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeNoteMathSource,
  NOTE_MATH_KATEX_OPTIONS,
  renderNoteMathFormula,
} from "./noteMathRenderer.ts";

test("note math renderer uses accessible, untrusted KaTeX output", () => {
  assert.equal(NOTE_MATH_KATEX_OPTIONS.displayMode, true);
  assert.equal(NOTE_MATH_KATEX_OPTIONS.output, "htmlAndMathml");
  assert.equal(NOTE_MATH_KATEX_OPTIONS.throwOnError, false);
  assert.equal(NOTE_MATH_KATEX_OPTIONS.trust, false);

  const html = renderNoteMathFormula(String.raw`E = mc^2`);
  assert.match(html, /class="katex-display"/);
  assert.match(html, /class="katex-mathml"/);
  assert.match(html, /<msup>/);
});

test("note math renderer handles prime shorthand and matrices", () => {
  const primes = renderNoteMathFormula(String.raw`f'(x) + x''`);
  assert.match(primes, /<msup>/);
  assert.match(primes, /′/);

  const matrix = renderNoteMathFormula(String.raw`\begin{pmatrix} a & b \\ c & d \end{pmatrix}^{-1}`);
  assert.match(matrix, /<mtable(?:\s|>)/);
  assert.match(matrix, /<msup>/);
});

test("note math renderer supports common LaTeX constructs without custom parsing", () => {
  const html = renderNoteMathFormula(
    String.raw`\sum_{i=1}^n \frac{\alpha_i}{\sqrt[3]{x_i}} \times \left\lVert v \right\rVert`,
  );
  assert.match(html, /∑/);
  assert.match(html, /<mfrac>/);
  assert.match(html, /<mroot>/);
  assert.match(html, /α/);
  assert.match(html, /∥/);
});

test("note math renderer accepts balanced outer display delimiters only", () => {
  assert.equal(normalizeNoteMathSource("  $$ x^2 $$  "), "x^2");
  assert.equal(normalizeNoteMathSource(String.raw`\[ x^2 \]`), "x^2");
  assert.equal(normalizeNoteMathSource("$$ x^2"), "$$ x^2");
  assert.equal(normalizeNoteMathSource("x^2 $$"), "x^2 $$");
});

test("note math renderer shows invalid input without throwing", () => {
  const html = renderNoteMathFormula(String.raw`\frac{`);
  assert.match(html, /class="katex-error"/);
  assert.match(html, /\\frac/);
});

test("note math renderer blocks untrusted links and external images", () => {
  const link = renderNoteMathFormula(String.raw`\href{javascript:alert(1)}{click}`);
  assert.doesNotMatch(link, /href=/i);

  const image = renderNoteMathFormula(String.raw`\includegraphics{https://example.com/x.png}`);
  assert.doesNotMatch(image, /<img/i);
});
