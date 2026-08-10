import assert from "node:assert/strict";
import test from "node:test";

import {
  expandCenteredMarkdownHtmlIslands,
  isPreviewableImageSrc,
  plainTextLooksLikeMarkdown,
  prepareNoteMarkdownForGithubPreview,
  rewriteUnpreviewableHtmlImages,
  rewriteUnpreviewableMarkdownImages,
  stripEmptyCenteredHtmlBlocks,
  stripEmptyMarkdownLinks,
} from "./notePreviewMarkdown.ts";

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

test("relative images are dropped silently; https kept", () => {
  assert.equal(isPreviewableImageSrc("public/icon.png"), false);
  assert.equal(isPreviewableImageSrc("https://example.com/a.png"), true);
  assert.equal(rewriteUnpreviewableMarkdownImages("![Netcatty](public/icon.png)"), "");
  assert.equal(
    rewriteUnpreviewableMarkdownImages("![shot](https://example.com/a.png)"),
    "![shot](https://example.com/a.png)",
  );
  assert.equal(
    rewriteUnpreviewableMarkdownImages("![cdn](//cdn.example.com/a.png)"),
    "![cdn](https://cdn.example.com/a.png)",
  );
});

test("relative HTML img is removed (no alt-as-title clutter)", () => {
  const out = rewriteUnpreviewableHtmlImages(
    '<img width="128" height="128" alt="Netcatty" src="public/icon.png" />',
  );
  assert.equal(out.trim(), "");
  assert.doesNotMatch(out, /Netcatty|public\/icon/);
});

test("empty markdown links and empty center shells are stripped", () => {
  assert.equal(stripEmptyMarkdownLinks("x [](https://example.com) y"), "x  y");
  assert.equal(
    stripEmptyCenteredHtmlBlocks('<div align="center">\n\n</div>\n\n# After').trim(),
    "# After",
  );
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
  assert.doesNotMatch(out, /# Netcatty/);
  assert.doesNotMatch(out, /!\[Netcatty\]/);
  assert.doesNotMatch(out, /public\/icon\.png/);
  assert.doesNotMatch(out, /\[\]\(/);
  // No alt-as-title leftover from missing logo
  assert.doesNotMatch(out, /note-preview-missing-image|\*Netcatty\*/);
});
