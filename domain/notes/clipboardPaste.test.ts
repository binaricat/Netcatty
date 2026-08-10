import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  convertClipboardHtmlToMarkdown,
  convertHtmlImgTagToMarkdownOrHtml,
  convertHtmlIslandsInMarkdown,
  decodeHtmlEntities,
  extractBalancedHtmlElement,
  maskCodeRegions,
  normalizeLinkedBadgeImages,
  normalizeNotePublicAssetPaths,
  normalizePastedNoteMarkdown,
  plainMarkdownContainsHtml,
  resolveNoteClipboardPaste,
  serializeSafeHtmlImage,
  shouldInterceptResolvedNotePaste,
  shouldInsertClipboardTextAsMarkdown,
  unmaskCodeRegions,
} from "./clipboardPaste.ts";

const CATTY_PASTE = `---

<img width="3142" height="1764" alt="Screenshot 2026-07-02 at 22 51 24" src="https://github.com/user-attachments/assets/3116165d-623a-4d3a-a28a-914befb9b72d" />

---

<a name="catty-agent"></a>
# 🔥 Catty Agent — Your IT Ops AI Partner

> 🚀 **Boost your IT ops daily work with AI power.** Catty Agent is the built-in AI assistant that understands your servers, executes commands, and handles complex multi-host operations — all through natural conversation.
### 🔥 What can Catty Agent do?

- 🚀 **Natural language server management** — just tell it what you need, no more memorizing commands
- 🔥 **Real-time server diagnostics** — check status, inspect logs, monitor resources through conversation
`;

test("centered README hero blocks wrap in div align=center", () => {
  const html = `
    <p align="center">
      <img src="https://example.com/icon.png" alt="Netcatty" width="128" height="128">
    </p>
    <h1 align="center">Netcatty</h1>
    <p align="center">
      <strong>🔥 AI-Powered SSH Client</strong><br/>
      <a href="https://netcatty.app">netcatty.app</a>
    </p>
  `;
  const md = convertClipboardHtmlToMarkdown(html);
  assert.match(md, /<div align="center">/);
  assert.match(md, /<\/div>/);
  assert.match(md, /width="128"/);
  assert.match(md, /height="128"/);
  assert.match(md, /# Netcatty/);
  assert.match(md, /netcatty\.app/);
  const centerIdx = md.indexOf('<div align="center">');
  const logoIdx = md.search(/icon\.png|# Netcatty/);
  assert.ok(centerIdx >= 0 && logoIdx >= 0 && centerIdx < logoIdx);
});

test("island conversion keeps center on p align=center with image", () => {
  const plain = `
<p align="center">
  <img src="https://example.com/icon.png" alt="Netcatty" width="128" height="128">
</p>

<h1 align="center">Netcatty</h1>
`;
  const md = convertHtmlIslandsInMarkdown(plain);
  assert.match(md, /<div align="center">/);
  assert.match(md, /width="128"/);
  assert.match(md, /Netcatty/);
});

test("relative public/ image paths map to Vite site root (not dropped)", () => {
  const md = convertHtmlIslandsInMarkdown(
    '<p align="center"><img src="public/icon.png" alt="Netcatty" width="128" height="128"></p>',
  );
  // Vite serves public/ at / — store /icon.png so the browser does not request /public/...
  assert.match(md, /src="\/icon\.png"/);
  assert.match(md, /width="128"/);
});

test("turndown converts pure html clipboard", () => {
  const html = `
    <html><body>
    <!--StartFragment-->
    <h1>Runbook</h1>
    <p>Restart <strong>sshd</strong> on <em>prod</em>.</p>
    <ul><li>check logs</li><li>open <a href="https://example.com">docs</a></li></ul>
    <img alt="shot" src="https://example.com/a.png" />
    <!--EndFragment-->
    </body></html>
  `;
  const md = convertClipboardHtmlToMarkdown(html);
  assert.match(md, /^# Runbook/m);
  assert.match(md, /\*\*sshd\*\*/);
  assert.match(md, /\[docs\]\(https:\/\/example\.com\)/);
  assert.match(md, /!\[shot\]\(https:\/\/example\.com\/a\.png\)/);
});

test("screenshot images keep width and height attributes", () => {
  const md = convertHtmlIslandsInMarkdown(CATTY_PASTE);
  assert.match(md, /^# 🔥 Catty Agent/m);
  assert.match(
    md,
    /<img\b[^>]*src="https:\/\/github\.com\/user-attachments\/assets\/3116165d-623a-4d3a-a28a-914befb9b72d"/,
  );
  assert.match(md, /width="3142"/);
  assert.match(md, /height="1764"/);
  assert.match(md, /alt="Screenshot 2026-07-02 at 22 51 24"/);
  assert.doesNotMatch(md, /\\#/);
  assert.doesNotMatch(md, /<a\s+name=/i);
});

test("serializeSafeHtmlImage preserves dimensions when present", () => {
  assert.equal(
    serializeSafeHtmlImage({
      src: "https://example.com/a.png",
      alt: "shot",
    }),
    "![shot](https://example.com/a.png)",
  );
  assert.match(
    serializeSafeHtmlImage({
      src: "https://example.com/a.png",
      alt: "shot",
      width: 3142,
      height: 1764,
    }),
    /<img\b[^>]*width="3142"[^>]*height="1764"[^>]*\/>/,
  );
  assert.match(
    serializeSafeHtmlImage({
      src: "https://cdn.ko-fi.com/cdn/kofi3.png?v=2",
      alt: "Support on Ko-fi",
      width: 150,
    }),
    /width="150"/,
  );
  assert.match(
    serializeSafeHtmlImage({
      src: "https://example.com/icon.png",
      alt: "icon",
      height: 24,
    }),
    /<img\b[^>]*height="24"[^>]*\/>/,
  );
});

test("serializeSafeHtmlImage keeps relative paths; rejects data/javascript", () => {
  // Relative README paths are kept (may 404 in-app, but must not vanish on paste).
  assert.equal(
    serializeSafeHtmlImage({ src: "./docs/screenshot.png", alt: "shot" }),
    "![shot](./docs/screenshot.png)",
  );
  assert.equal(
    serializeSafeHtmlImage({ src: "public/icon.png", alt: "logo" }),
    "![logo](/icon.png)",
  );
  // Protocol-relative → https (covered more fully below; keep here as non-drop).
  assert.equal(
    serializeSafeHtmlImage({
      src: "//cdn.example.com/a.png",
      alt: "cdn",
    }),
    "![cdn](https://cdn.example.com/a.png)",
  );
  assert.equal(
    serializeSafeHtmlImage({ src: "data:image/png;base64,aaa", alt: "x" }),
    "",
  );
  assert.equal(
    serializeSafeHtmlImage({ src: "javascript:alert(1)", alt: "x" }),
    "",
  );
});

test("linked badge images stay as images (tight single-line / a>img), not text-only", () => {
  const source = [
    "[![GitHub Release](https://img.shields.io/github/v/release/binaricat/Netcatty)](https://github.com/binaricat/Netcatty/releases/latest)",
    "",
    "[ ",
    "![Platform](https://img.shields.io/badge/Platform-macOS-blue)",
    " ](#)",
    "",
    "[",
    '<img alt="Support on Ko-fi" width="150" src="https://cdn.ko-fi.com/cdn/kofi3.png?v=2" />',
    "](https://ko-fi.com/binaricat)",
    "",
    '<a href="https://example.com/dl"><img alt="Download" src="https://img.shields.io/badge/Download-latest-success" /></a>',
  ].join("\n");

  const md = normalizeLinkedBadgeImages(source);
  // Markdown linked image kept (with image src), not reduced to text-only [GitHub Release](url).
  assert.match(
    md,
    /\[!\[GitHub Release\]\(https:\/\/img\.shields\.io\/github\/v\/release\/binaricat\/Netcatty\)\]\(https:\/\/github\.com\/binaricat\/Netcatty\/releases\/latest\)/,
  );
  assert.match(md, /\[!\[Platform\]\(https:\/\/img\.shields\.io\/badge\/Platform-macOS-blue\)\]\(#\)/);
  // HTML img with width inside link → <a><img width></a>
  assert.match(md, /<a href="https:\/\/ko-fi\.com\/binaricat"><img\b[^>]*src="https:\/\/cdn\.ko-fi\.com\/cdn\/kofi3\.png\?v=2"/);
  // Dimension-less shield inside <a> → linked markdown image
  assert.match(
    md,
    /\[!\[Download\]\(https:\/\/img\.shields\.io\/badge\/Download-latest-success\)\]\(https:\/\/example\.com\/dl\)/,
  );
  assert.doesNotMatch(md, /^\s*\]\(/m);
  // Not text-only badge (must keep image syntax).
  assert.doesNotMatch(
    md,
    /(?<!!)\[GitHub Release\]\(https:\/\/github\.com\/binaricat\/Netcatty\/releases\/latest\)/,
  );
});

test("normalize removes orphan link closers but keeps image dimensions", () => {
  const messy = [
    "Intro",
    "](https://example.com/orphan)",
    '<img width="2000" height="1000" alt="wide" src="https://example.com/w.png" />',
    "Done",
  ].join("\n");
  const md = normalizePastedNoteMarkdown(messy);
  assert.doesNotMatch(md, /\]\(https:\/\/example\.com\/orphan\)/);
  assert.match(md, /src="https:\/\/example\.com\/w\.png"/);
  assert.match(md, /width="2000"/);
  assert.match(md, /height="1000"/);
});

test("normalize keeps link-closer lines inside fenced and indented code", () => {
  const source = [
    "Before",
    "](https://example.com/orphan)",
    "```md",
    "](https://example.com)",
    "```",
    "",
    "    ](https://example.com/indented)",
    "After",
  ].join("\n");
  const md = normalizePastedNoteMarkdown(source);
  assert.doesNotMatch(md, /^\]\(https:\/\/example\.com\/orphan\)$/m);
  assert.match(md, /```md\n\]\(https:\/\/example\.com\)\n```/);
  assert.match(md, /^ {4}\]\(https:\/\/example\.com\/indented\)$/m);
});

test("resolve pastes Catty-style mixed markdown+html with image sizes", () => {
  const payload = resolveNoteClipboardPaste({
    plainText: CATTY_PASTE,
    htmlText: "",
  });
  assert.ok(payload.kind === "html-converted" || payload.kind === "markdown");
  assert.equal(
    shouldInterceptResolvedNotePaste({
      editorMode: "edit",
      pasteInsideCodeBlock: false,
      payload,
    }),
    true,
  );
  assert.match(payload.text, /^# 🔥 Catty Agent/m);
  assert.match(payload.text, /width="3142"/);
  assert.match(payload.text, /height="1764"/);
});

test("repo README paste collapses shields badges without debris", () => {
  const readmeHead = readFileSync(new URL("../../README.md", import.meta.url), "utf8").slice(0, 2200);
  const payload = resolveNoteClipboardPaste({ plainText: readmeHead, htmlText: "" });
  assert.ok(payload.text.length > 50);
  assert.doesNotMatch(payload.text, /^\s*\]\([^)\n]+\)\s*$/m);
  // Large screenshot keeps dimensions in source.
  assert.match(payload.text, /width="3142"/);
  assert.match(payload.text, /height="1764"/);
});

test("resolve uses full turndown for browser StartFragment html", () => {
  const payload = resolveNoteClipboardPaste({
    plainText: "flat text without structure",
    htmlText: `
      <html><body>
      <!--StartFragment-->
      <h1>From browser</h1>
      <p>Hello <b>world</b></p>
      <img alt="x" src="https://cdn.example.com/x.png" width="2000" height="1000" />
      <!--EndFragment-->
      </body></html>
    `,
  });
  assert.equal(payload.kind, "html-converted");
  assert.match(payload.text, /^# From browser/m);
  assert.match(payload.text, /\*\*world\*\*/);
  assert.match(payload.text, /src="https:\/\/cdn\.example\.com\/x\.png"/);
  assert.match(payload.text, /width="2000"/);
  assert.match(payload.text, /height="1000"/);
});

test("resolve uses structured plain markdown when html is absent", () => {
  const payload = resolveNoteClipboardPaste({
    plainText: "# From .md file\n\n- item",
    htmlText: "",
  });
  assert.equal(payload.kind, "markdown");
  assert.match(payload.text, /# From \.md file/);
});

test("plain unstructured text is not intercepted", () => {
  assert.equal(shouldInsertClipboardTextAsMarkdown("hello world"), false);
  const payload = resolveNoteClipboardPaste({
    plainText: "hello world",
    htmlText: "",
  });
  assert.equal(payload.kind, "plain");
  assert.equal(
    shouldInterceptResolvedNotePaste({
      editorMode: "edit",
      pasteInsideCodeBlock: false,
      payload,
    }),
    false,
  );
});

test("structured plain markdown wins over presentation HTML wrappers", () => {
  const payload = resolveNoteClipboardPaste({
    plainText: "# Title\n\n- item one",
    htmlText: "<div><div># Title</div><div>- item one</div></div>",
  });
  assert.equal(payload.kind, "markdown");
  assert.match(payload.text, /^# Title/m);
  assert.doesNotMatch(payload.text, /\\# Title/);
});

test("TypeScript generics are not treated as HTML islands", () => {
  assert.equal(plainMarkdownContainsHtml("const values: List<string> = []"), false);
  assert.equal(plainMarkdownContainsHtml("type M = Map<string, number>"), false);
  assert.equal(plainMarkdownContainsHtml("fn(): Promise<boolean>"), false);
  assert.equal(plainMarkdownContainsHtml("Use <span>status</span> here"), true);
  assert.equal(plainMarkdownContainsHtml('<img src="https://x.com/a.png" />'), true);
  assert.equal(plainMarkdownContainsHtml("<div>block</div>"), true);
});

test("hard-break trailing spaces are kept outside code", () => {
  const source = "line one  \nline two\n\n\nline three";
  const md = normalizePastedNoteMarkdown(source);
  assert.match(md, /line one {2}\nline two/);
  assert.doesNotMatch(md, /\n{3,}/);
});

test("http and protocol-relative image src normalize to https", () => {
  assert.equal(
    serializeSafeHtmlImage({ src: "http://example.com/a.png", alt: "a" }),
    "![a](https://example.com/a.png)",
  );
  assert.equal(
    serializeSafeHtmlImage({ src: "//cdn.example.com/a.png", alt: "cdn" }),
    "![cdn](https://cdn.example.com/a.png)",
  );
});

test("image attributes decode entities before re-serialize", () => {
  const md = convertHtmlImgTagToMarkdownOrHtml(
    '<img width="100" alt="A &amp; B" src="https://example.com/a.png?x=1&amp;y=2" />',
  );
  assert.match(md, /alt="A &amp; B"/);
  assert.match(md, /src="https:\/\/example\.com\/a\.png\?x=1&amp;y=2"/);
  assert.doesNotMatch(md, /&amp;amp;/);
});

test("img alt with > inside quotes is not truncated", () => {
  const md = convertHtmlImgTagToMarkdownOrHtml(
    '<img alt="A > B" src="https://example.com/a.png" width="20" />',
  );
  assert.match(md, /alt="A &gt; B"/);
  assert.match(md, /src="https:\/\/example\.com\/a\.png"/);
  assert.match(md, /width="20"/);
});

test("fenced code with ](url) and <img> examples is not rewritten", () => {
  const source = [
    "# Doc",
    "",
    "```md",
    "](https://example.com)",
    '<img src="https://example.com/x.png" />',
    "```",
    "",
    "Use `<span>status</span>` inline.",
  ].join("\n");
  const md = normalizePastedNoteMarkdown(source);
  assert.match(md, /```md\n\]\(https:\/\/example\.com\)/);
  assert.match(md, /<img src="https:\/\/example\.com\/x\.png" \/>/);
  assert.match(md, /`<span>status<\/span>`/);
});

test("nested same-tag HTML islands convert without truncating outer close", () => {
  const md = convertHtmlIslandsInMarkdown(
    '<div><div>inner</div><p>after</p></div>\n\n# Done',
  );
  assert.match(md, /inner/);
  assert.match(md, /after/);
  assert.match(md, /# Done/);
});

test("decodeHtmlEntities ignores out-of-range numeric entities", () => {
  assert.equal(decodeHtmlEntities("ok &#65; end"), "ok A end");
  assert.equal(decodeHtmlEntities("bad &#1114112; keep"), "bad &#1114112; keep");
  assert.equal(decodeHtmlEntities("bad &#x110000; keep"), "bad &#x110000; keep");
  assert.doesNotThrow(() => decodeHtmlEntities("&#x110000;&#1114112;"));
});

test("serializeSafeHtmlImage angles destinations that contain spaces", () => {
  assert.equal(
    serializeSafeHtmlImage({ src: "images/company logo.png", alt: "logo" }),
    "![logo](<images/company logo.png>)",
  );
});

test("indented code HTML samples are not converted as islands", () => {
  const source = [
    "Intro",
    "",
    "    <img src=\"https://example.com/code.png\" />",
    "",
    '<img src="https://example.com/real.png" />',
  ].join("\n");
  const md = convertHtmlIslandsInMarkdown(source);
  assert.match(md, / {4}<img src="https:\/\/example\.com\/code\.png" \/>/);
  assert.match(md, /!\[\]\(https:\/\/example\.com\/real\.png\)|src="https:\/\/example\.com\/real\.png"/);
});

test("linked badge examples inside fenced code are not rewritten", () => {
  const source = [
    "```md",
    "[![shield](http://img.shields.io/badge/x-1-blue)](http://example.com)",
    "```",
    "",
    "[![live](http://img.shields.io/badge/y-2-green)](http://example.com)",
  ].join("\n");
  const md = normalizePastedNoteMarkdown(source);
  assert.match(md, /```md\n\[!\[shield\]\(http:\/\/img\.shields\.io/);
  assert.match(md, /!\[live\]\(https:\/\/img\.shields\.io/);
});

test("img getAttr prefers real src over data-src", () => {
  const md = convertHtmlImgTagToMarkdownOrHtml(
    '<img data-src="https://lazy.example/x.png" src="https://real.example/y.png" alt="pic" />',
  );
  assert.match(md, /real\.example\/y\.png/);
  assert.doesNotMatch(md, /lazy\.example/);
});

test("normalizeNotePublicAssetPaths leaves public/ samples inside code alone", () => {
  const source = [
    "See `public/icon.png` and:",
    "",
    "```md",
    "![x](public/icon.png)",
    "```",
    "",
    "![live](public/icon.png)",
  ].join("\n");
  const md = normalizeNotePublicAssetPaths(source);
  assert.match(md, /`public\/icon\.png`/);
  assert.match(md, /```md\n!\[x\]\(public\/icon\.png\)/);
  assert.match(md, /!\[live\]\(\/icon\.png\)/);
});

test("maskCodeRegions covers indented and blockquote fences", () => {
  const source = [
    "  ```md",
    "  - [ ] fake",
    "  ```",
    "",
    "> ```",
    "> - [ ] quoted-fake",
    "> ```",
    "",
    "- [ ] real",
  ].join("\n");
  const { text } = maskCodeRegions(source);
  assert.doesNotMatch(text, /- \[ \] fake/);
  assert.doesNotMatch(text, /- \[ \] quoted-fake/);
  assert.match(text, /- \[ \] real/);
});

test("maskCodeRegions does not hide nested list tasks as indented code", () => {
  const source = [
    "- parent",
    "    - [ ] child",
    "- [ ] later",
    "",
    "    plain indented code",
  ].join("\n");
  const { text } = maskCodeRegions(source);
  assert.match(text, / {4}- \[ \] child/);
  assert.match(text, /- \[ \] later/);
  assert.doesNotMatch(text, /plain indented code/);
});

test("maskCodeRegions sentinels do not collide with user-authored tokens", () => {
  const source = [
    "keep @@NETCATTY_MD_CODE_0@@ literal",
    "",
    "```",
    "code body",
    "```",
  ].join("\n");
  const mask = maskCodeRegions(source);
  assert.match(mask.text, /keep @@NETCATTY_MD_CODE_0@@ literal/);
  assert.notEqual(mask.sentinel, "@@NETCATTY_MD_CODE_");
  const restored = unmaskCodeRegions(mask.text, mask.slots, mask.sentinel);
  assert.equal(restored, source);
});

test("linked badge anchors prefer real href over data-href", () => {
  const md = normalizeLinkedBadgeImages(
    '<a data-href="https://wrong.example" href="https://right.example"><img src="https://img.example/a.png" alt="a" /></a>',
  );
  assert.match(md, /right\.example/);
  assert.doesNotMatch(md, /wrong\.example/);
});

test("maskCodeRegions accepts longer closing fences", () => {
  const source = [
    "```md",
    "![x](public/icon.png)",
    "- [ ] fake",
    "````",
    "",
    "- [ ] real",
  ].join("\n");
  const mask = maskCodeRegions(source);
  assert.doesNotMatch(mask.text, /public\/icon\.png/);
  assert.doesNotMatch(mask.text, /- \[ \] fake/);
  assert.match(mask.text, /- \[ \] real/);
  assert.equal(unmaskCodeRegions(mask.text, mask.slots, mask.sentinel), source);
});

test("maskCodeRegions keeps info strings starting with the other fence char", () => {
  // Opening is three backticks; info may start with ~ without lengthening the fence.
  const source = ["```~tip", "![x](public/a.png)", "```", "", "after"].join("\n");
  const mask = maskCodeRegions(source);
  assert.doesNotMatch(mask.text, /public\/a\.png/);
  assert.match(mask.text, /after/);
  assert.equal(unmaskCodeRegions(mask.text, mask.slots, mask.sentinel), source);
});

test("maskCodeRegions masks multi-backtick spans with inner shorter runs", () => {
  const source = "Use ``a ` ![x](public/a.png) b`` end";
  const mask = maskCodeRegions(source);
  assert.doesNotMatch(mask.text, /public\/a\.png/);
  assert.match(mask.text, / end$/);
  assert.equal(unmaskCodeRegions(mask.text, mask.slots, mask.sentinel), source);
});

test("maskCodeRegions masks standalone indented task samples as code", () => {
  const source = ["    - [ ] sample", "", "- [ ] real"].join("\n");
  const mask = maskCodeRegions(source);
  assert.doesNotMatch(mask.text, /- \[ \] sample/);
  assert.match(mask.text, /- \[ \] real/);
});

test("normalizeLinkedBadgeImages preserves angled destinations with spaces", () => {
  const md = normalizeLinkedBadgeImages(
    "[![logo](<images/company logo.png>)](https://example.com)",
  );
  assert.match(md, /company logo\.png|company%20logo\.png|company logo/);
  assert.match(md, /example\.com/);
  assert.doesNotMatch(md, /<images\/company(?! logo)/);
});

test("maskCodeRegions masks multi-level blockquote fences", () => {
  const source = [
    "> > ~~~md",
    "> > ![x](public/a.png)",
    "> > ~~~",
    "",
    "after",
  ].join("\n");
  const mask = maskCodeRegions(source);
  assert.doesNotMatch(mask.text, /public\/a\.png/);
  assert.match(mask.text, /after/);
});

test("extractBalancedHtmlElement handles raw-text script bodies with <", () => {
  const source = '<script>if (a < b) alert(1)</script>\n# after';
  const extracted = extractBalancedHtmlElement(source, 0);
  assert.ok(extracted);
  assert.equal(extracted?.tag, "script");
  assert.match(extracted?.full ?? "", /if \(a < b\)/);
  assert.equal(source.slice(extracted?.end ?? 0), "\n# after");
});
