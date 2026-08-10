import assert from "node:assert/strict";
import test from "node:test";

import {
  expandCenteredMarkdownHtmlIslands,
  isOversizedCenterInner,
  isPreviewableImageSrc,
  plainTextLooksLikeMarkdown,
  prepareNoteMarkdownForGithubPreview,
  resolveNoteImageSrc,
  rewriteNoteHtmlImages,
  rewriteNoteMarkdownImages,
  stripEmptyCenteredHtmlBlocks,
  stripEmptyMarkdownLinks,
  unwrapOversizedCenteredHtmlBlocks,
} from "./notePreviewMarkdown.ts";

import { normalizeImageSrc } from "./clipboardPaste.ts";

test("plainTextLooksLikeMarkdown detects headings links images emphasis", () => {
  assert.equal(plainTextLooksLikeMarkdown("# Title\n\n**x**"), true);
  assert.equal(plainTextLooksLikeMarkdown("[![b](https://x.com/a.png)](https://x.com)"), true);
  assert.equal(
    plainTextLooksLikeMarkdown('<a href="https://x.com"><img src="https://x.com/a.png" alt="b" /></a>'),
    false,
  );
});

test("expandCenteredMarkdownHtmlIslands renders markdown inside center div", () => {
  const source = [
    '<div align="center">',
    "",
    "# Netcatty",
    "",
    "**bold** and [link](https://example.com)",
    "",
    "[![badge](https://img.shields.io/badge/x-y-blue)](https://example.com)",
    "",
    "</div>",
    "",
    "After",
  ].join("\n");

  const out = expandCenteredMarkdownHtmlIslands(source);
  assert.match(out, /<div align="center">/);
  assert.match(out, /<h1[^>]*>Netcatty<\/h1>/);
  assert.match(out, /<strong>bold<\/strong>/);
  assert.match(out, /href="https:\/\/example\.com"/);
  assert.match(out, /src="https:\/\/img\.shields\.io\/badge\/x-y-blue"/);
  assert.doesNotMatch(out, /# Netcatty/);
  assert.doesNotMatch(out, /\*\*bold\*\*/);
  assert.match(out, /After/);
});

test("expand leaves pure HTML center badges alone", () => {
  const source = [
    '<div align="center">',
    '<a href="https://example.com"><img src="https://img.shields.io/badge/x-y-blue" alt="badge" /></a>',
    "</div>",
  ].join("\n");
  const out = expandCenteredMarkdownHtmlIslands(source);
  assert.match(out, /img\.shields\.io/);
  assert.match(out, /align="center"/);
});

test("Vite public/ assets rewrite to site root; relative kept; https kept", () => {
  assert.equal(normalizeImageSrc("public/icon.png"), "/icon.png");
  assert.equal(normalizeImageSrc("/public/icon.png"), "/icon.png");
  assert.equal(normalizeImageSrc("public/distro/ubuntu.svg"), "/distro/ubuntu.svg");
  assert.equal(normalizeImageSrc("./docs/shot.png"), "./docs/shot.png");
  assert.equal(normalizeImageSrc("/icon.png"), "/icon.png");
  assert.equal(resolveNoteImageSrc("public/icon.png"), "/icon.png");
  assert.equal(isPreviewableImageSrc("public/icon.png"), true);
  assert.equal(isPreviewableImageSrc("https://example.com/a.png"), true);

  assert.equal(
    rewriteNoteMarkdownImages("![Netcatty](public/icon.png)"),
    "![Netcatty](/icon.png)",
  );
  assert.equal(
    rewriteNoteMarkdownImages("![shot](https://example.com/a.png)"),
    "![shot](https://example.com/a.png)",
  );
  assert.equal(
    rewriteNoteMarkdownImages("![cdn](//cdn.example.com/a.png)"),
    "![cdn](https://cdn.example.com/a.png)",
  );
});

test("HTML img public/ paths rewrite; not dropped", () => {
  const out = rewriteNoteHtmlImages(
    '<img width="128" height="128" alt="Netcatty" src="public/icon.png" />',
  );
  assert.match(out, /src="\/icon\.png"/);
  assert.match(out, /alt="Netcatty"/);
  assert.doesNotMatch(out, /public\/icon/);
});

test("empty markdown links and empty center shells are stripped", () => {
  assert.equal(stripEmptyMarkdownLinks("x [](https://example.com) y"), "x  y");
  assert.equal(
    stripEmptyCenteredHtmlBlocks('<div align="center">\n\n</div>\n\n# After').trim(),
    "# After",
  );
});

test("oversized center blocks with Features/lists are unwrapped", () => {
  assert.equal(isOversizedCenterInner("<h2>Features</h2><ul><li>a</li><li>b</li><li>c</li><li>d</li></ul>"), true);
  assert.equal(isOversizedCenterInner("<h1>Netcatty</h1><p>tagline</p>"), false);

  const nested = [
    '<div align="center">',
    "<h1>Features</h1>",
    "<h2>Vault</h2>",
    "<ul><li>a</li><li>b</li><li>c</li><li>d</li></ul>",
    "</div>",
  ].join("\n");
  const out = unwrapOversizedCenteredHtmlBlocks(nested);
  assert.doesNotMatch(out, /align="center"/);
  assert.match(out, /Features/);
});

test("prepareNoteMarkdownForGithubPreview end-to-end README head shape", () => {
  const source = [
    '<div align="center">',
    "",
    "![Netcatty](public/icon.png)",
    "",
    "# Netcatty",
    "",
    "**🔥 AI-Powered SSH Client**",
    "",
    "[![GitHub Release](https://img.shields.io/github/v/release/binaricat/Netcatty)](https://github.com/binaricat/Netcatty/releases/latest)",
    "",
    "[](https://github.com/binaricat/Netcatty/releases/latest)",
    "",
    "</div>",
    "",
    "---",
    "",
    '<img width="3142" height="1764" alt="shot" src="https://github.com/user-attachments/assets/abc.png" />',
    "",
    "# Body left aligned",
  ].join("\n");

  const out = prepareNoteMarkdownForGithubPreview(source);
  assert.match(out, /<h1[^>]*>Netcatty<\/h1>/);
  assert.match(out, /<strong>/);
  assert.match(out, /img\.shields\.io/);
  assert.match(out, /width="3142"/);
  assert.match(out, /# Body left aligned/);
  // Logo kept as app-root path (Vite public/)
  assert.match(out, /src="\/icon\.png"|!\[Netcatty\]\(\/icon\.png\)/);
  assert.doesNotMatch(out, /# Netcatty/);
  assert.doesNotMatch(out, /public\/icon\.png/);
  assert.doesNotMatch(out, /\[\]\(/);
  assert.doesNotMatch(out, /raw\.githubusercontent\.com/);
});
