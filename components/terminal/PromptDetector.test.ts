import test from "node:test";
import assert from "node:assert/strict";

import { getAlignedPrompt } from "./autocomplete/promptDetector.ts";

function createFakeTerm(lineText: string, cursorX: number) {
  return {
    buffer: {
      active: {
        cursorX,
        cursorY: 0,
        baseY: 0,
        getLine(line: number) {
          if (line !== 0) return undefined;
          return {
            isWrapped: false,
            translateToString() {
              return lineText;
            },
          };
        },
      },
    },
  };
}

test("prefers the typed buffer when shell echo is still one character behind", () => {
  const term = createFakeTerm("$ do", 4);

  const result = getAlignedPrompt(term as never, "doc", true);

  assert.equal(result.prompt.isAtPrompt, true);
  assert.equal(result.prompt.promptText, "$ ");
  assert.equal(result.prompt.userInput, "doc");
  assert.equal(result.prompt.cursorOffset, 3);
  assert.equal(result.alignedTyped, "doc");
});

test("still trims prompt decorations out of the detected input", () => {
  const term = createFakeTerm("➜  ~ do", 7);

  const result = getAlignedPrompt(term as never, "do", true);

  assert.equal(result.prompt.isAtPrompt, true);
  assert.equal(result.prompt.promptText, "➜  ~ ");
  assert.equal(result.prompt.userInput, "do");
  assert.equal(result.prompt.cursorOffset, 2);
  assert.equal(result.alignedTyped, "do");
});
