import assert from "node:assert/strict";
import test from "node:test";

import { createProgrammaticCommandLogRewriter } from "./programmaticCommandLog.ts";

test("rewrites a protected snippet echo to the readable command", () => {
  const rewriter = createProgrammaticCommandLogRewriter();

  rewriter.queueRewrite({
    sentCommand: "sh -c 'private setup' && eval 'wrapped command'",
    displayCommand: "sudo apt update && sudo apt upgrade -y",
  });

  const output = rewriter.append("sh -c 'private setup' && eval 'wrapped command'\r\nDone\r\n");

  assert.equal(output, "sudo apt update && sudo apt upgrade -y\r\nDone\r\n");
});

test("rewrites a protected snippet echo split across terminal data chunks", () => {
  const rewriter = createProgrammaticCommandLogRewriter();

  rewriter.queueRewrite({
    sentCommand: "sh -c 'private setup' && eval 'wrapped command'",
    displayCommand: "uptime",
  });

  const first = rewriter.append("before\r\nsh -c 'private");
  const second = rewriter.append(" setup' && eval 'wrapped command'\r\nafter\r\n");

  assert.equal(first, "before\r\n");
  assert.equal(second, "uptime\r\nafter\r\n");
});

test("finish returns an unmatched partial echo and clears stale rewrites", () => {
  const rewriter = createProgrammaticCommandLogRewriter();

  rewriter.queueRewrite({
    sentCommand: "wrapped-one",
    displayCommand: "one",
  });
  assert.equal(rewriter.append("wrapped-"), "");
  assert.equal(rewriter.finish(), "wrapped-");

  rewriter.queueRewrite({
    sentCommand: "wrapped-two",
    displayCommand: "two",
  });
  assert.equal(rewriter.append("wrapped-two\r\n"), "two\r\n");
});
