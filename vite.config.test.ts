import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import {
  isFontsourceStylesheetId,
  stripFontsourceWoffFallbacks,
} from "./vite.config.ts";

test("vite dev CSP allows eval only for development runtime", () => {
  const source = readFileSync(new URL("./vite.config.ts", import.meta.url), "utf8");

  assert.match(source, /devContentSecurityPolicy/);
  assert.match(source, /'unsafe-eval'/);
  assert.match(source, /transformIndexHtml/);
  assert.doesNotMatch(source, /index\.html.*unsafe-eval/);
});

test("isFontsourceStylesheetId matches POSIX, Windows, and query-suffixed @fontsource CSS paths", () => {
  assert.equal(isFontsourceStylesheetId("/repo/node_modules/@fontsource/mona-sans/400.css"), true);
  assert.equal(isFontsourceStylesheetId("C:\\repo\\node_modules\\@fontsource\\jetbrains-mono\\600.css?used"), true);
  assert.equal(isFontsourceStylesheetId("/repo/index.css"), false);
  assert.equal(isFontsourceStylesheetId("/repo/node_modules/@fontsource/mona-sans/files/font.woff2"), false);
});

test("stripFontsourceWoffFallbacks removes redundant .woff fallbacks while preserving .woff2 and woff-only declarations", () => {
  const input = [
    "@font-face {",
    "  font-family: 'Mona Sans';",
    "  src: url(./files/mona-sans-latin-400-normal.woff2) format('woff2'), url(./files/mona-sans-latin-400-normal.woff) format('woff');",
    "}",
    "@font-face {",
    '  font-family: "Reversed";',
    '  src: url("./rev.woff") format("woff"), url("./rev.woff2") format("woff2");',
    "}",
    "@font-face {",
    "  font-family: 'LegacyOnly';",
    "  src: url(./legacy.woff) format('woff');",
    "}",
  ].join("\n");

  const output = stripFontsourceWoffFallbacks(input);
  assert.match(output, /src: url\(\.\/files\/mona-sans-latin-400-normal\.woff2\) format\('woff2'\);/);
  assert.doesNotMatch(output, /mona-sans-latin-400-normal\.woff\b/);
  assert.match(output, /src: url\("\.\/rev\.woff2"\) format\("woff2"\);/);
  assert.doesNotMatch(output, /rev\.woff"\)/);
  assert.match(output, /src: url\(\.\/legacy\.woff\) format\('woff'\);/);
});

test("bundled Nerd Font uses valid WOFF2 binary and retains its license", () => {
  const woff2Url = new URL("./public/fonts/SymbolsNerdFontMono-Regular.woff2", import.meta.url);
  const ttfUrl = new URL("./public/fonts/SymbolsNerdFontMono-Regular.ttf", import.meta.url);
  const licenseUrl = new URL("./public/fonts/SymbolsNerdFont-LICENSE.txt", import.meta.url);
  const indexCss = readFileSync(new URL("./index.css", import.meta.url), "utf8");

  assert.equal(existsSync(woff2Url), true);
  assert.equal(existsSync(ttfUrl), false);
  assert.equal(existsSync(licenseUrl), true);
  assert.equal(readFileSync(woff2Url).subarray(0, 4).toString("ascii"), "wOF2");
  assert.match(indexCss, /url\("\/fonts\/SymbolsNerdFontMono-Regular\.woff2"\) format\("woff2"\)/);
  assert.doesNotMatch(indexCss, /SymbolsNerdFontMono-Regular\.ttf/);
});
