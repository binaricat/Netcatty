"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { isTerminalReportSequence } = require("./terminalReportSequence.cjs");

test("recognizes terminal-generated report families without classifying ordinary input", () => {
  for (const report of [
    "\x1b[I",
    "\x1b[1;2R",
    "\x1b[?1;2c",
    "\x1b[?997;1n",
    "\x1b[?3u",
    "\x1b[?2004;1$y",
    "\x1b[8;24;80t",
    "\x1b[4;1080;1920t",
    "\x1b]10;rgb:ffff/ffff/ffff\x1b\\",
    "\x1b]4;255;rgb:ffff/0000/ffff\x1b\\",
    "\x1b]11;rgb:0000/0000/0000\x07",
    "\x1b]4;7;rgb:1111/2222/3333\x07",
    "\x1b]52;c;c2VjcmV0Cg==\x07",
    "\x1b]52;c;\x1b\\",
    "\x1bP1$r0m\x1b\\",
  ]) {
    assert.equal(isTerminalReportSequence(report), true, JSON.stringify(report));
  }
  for (const input of ["hello", "\r", "\x1b[A", "\x1b[200~paste\x1b[201~"]) {
    assert.equal(isTerminalReportSequence(input), false, JSON.stringify(input));
  }
});
