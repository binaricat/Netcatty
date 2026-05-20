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

test("detects oh-my-posh Nerd Font chevron (U+F105) prompt terminator", () => {
  // Real-world PS1 captured from oh-my-posh themed bash on a server:
  //   "<U+F31B> root@oracle ~ <U+F105> " then user input
  const term = createFakeTerm(" root@oracle ~  ls", 21);

  const result = getAlignedPrompt(term as never, "ls", true);

  assert.equal(result.prompt.isAtPrompt, true);
  assert.equal(result.prompt.promptText, " root@oracle ~  ");
  assert.equal(result.prompt.userInput, "ls");
});

test("detects Powerline right-arrow (U+E0B0) prompt terminator", () => {
  // oh-my-posh agnoster-style: colored block ending with U+E0B0 + space
  const term = createFakeTerm(" root  ~  git", 16);

  const result = getAlignedPrompt(term as never, "git", true);

  assert.equal(result.prompt.isAtPrompt, true);
  assert.equal(result.prompt.userInput, "git");
  assert.ok(result.prompt.promptText.endsWith(" "));
});

test("PUA char without trailing space is not a prompt boundary", () => {
  // A bare PUA glyph mid-token (e.g. paste artifact) should not trigger detection.
  const term = createFakeTerm("echo foo", 13);

  const result = getAlignedPrompt(term as never, "", true);

  assert.equal(result.prompt.isAtPrompt, false);
});

test("keeps typed command intact when command text contains Powerline glyphs", () => {
  const typedInput = "echo  foo";
  const lineText = `$ ${typedInput}`;
  const term = createFakeTerm(lineText, lineText.length);

  const result = getAlignedPrompt(term as never, typedInput, true);

  assert.equal(result.prompt.isAtPrompt, true);
  assert.equal(result.prompt.promptText, "$ ");
  assert.equal(result.prompt.userInput, typedInput);
  assert.equal(result.alignedTyped, typedInput);
});

test("does not treat a mid-line dollar as a prompt boundary", () => {
  const lineText = "$ echo $HOME";
  const term = createFakeTerm(lineText, "$ echo $".length);

  const result = getAlignedPrompt(term as never, "", true);

  assert.equal(result.prompt.isAtPrompt, true);
  assert.equal(result.prompt.promptText, "$ ");
  assert.equal(result.prompt.userInput, "echo $");
  assert.equal(result.prompt.cursorOffset, "echo $".length);
});

test("does not treat a mid-line redirection as a prompt boundary", () => {
  const lineText = "$ cat >file";
  const term = createFakeTerm(lineText, "$ cat >".length);

  const result = getAlignedPrompt(term as never, "", true);

  assert.equal(result.prompt.isAtPrompt, true);
  assert.equal(result.prompt.promptText, "$ ");
  assert.equal(result.prompt.userInput, "cat >");
  assert.equal(result.prompt.cursorOffset, "cat >".length);
});

test("prefers standard prompt terminator over later Powerline glyphs", () => {
  const lineText = "$ echo  foo";
  const term = createFakeTerm(lineText, lineText.length);

  const result = getAlignedPrompt(term as never, "", true);

  assert.equal(result.prompt.isAtPrompt, true);
  assert.equal(result.prompt.promptText, "$ ");
  assert.equal(result.prompt.userInput, "echo  foo");
});

test("ignores xterm row padding after a no-space root prompt", () => {
  const prompt = " root@stwo:~#";
  const term = createFakeTerm(`${prompt}          `, prompt.length);

  const result = getAlignedPrompt(term as never, "", true);

  assert.equal(result.prompt.isAtPrompt, true);
  assert.equal(result.prompt.promptText, prompt);
  assert.equal(result.prompt.userInput, "");
});

test("aligns typed input after a no-space root prompt", () => {
  const prompt = " root@stwo:~#";
  const typedInput = "printf ok";
  const lineText = `${prompt}${typedInput}`;
  const term = createFakeTerm(lineText, lineText.length);

  const result = getAlignedPrompt(term as never, typedInput, true);

  assert.equal(result.prompt.isAtPrompt, true);
  assert.equal(result.prompt.promptText, prompt);
  assert.equal(result.prompt.userInput, typedInput);
  assert.equal(result.alignedTyped, typedInput);
});

test("does not resurrect python REPL prompts during fallback alignment", () => {
  const typedInput = "print('ok')";
  const lineText = `>>> ${typedInput}`;
  const term = createFakeTerm(lineText, lineText.length);

  const result = getAlignedPrompt(term as never, typedInput, true);

  assert.equal(result.prompt.isAtPrompt, false);
  assert.equal(result.alignedTyped, null);
});

test("does not resurrect mysql REPL prompts during fallback alignment", () => {
  const typedInput = "select 1";
  const lineText = `mysql> ${typedInput}`;
  const term = createFakeTerm(lineText, lineText.length);

  const result = getAlignedPrompt(term as never, typedInput, true);

  assert.equal(result.prompt.isAtPrompt, false);
  assert.equal(result.alignedTyped, null);
});

test("does not resurrect shell continuation prompts during fallback alignment", () => {
  const typedInput = "echo ok";
  const lineText = `> ${typedInput}`;
  const term = createFakeTerm(lineText, lineText.length);

  const result = getAlignedPrompt(term as never, typedInput, true);

  assert.equal(result.prompt.isAtPrompt, false);
  assert.equal(result.alignedTyped, null);
});

test("does not resurrect no-space python REPL prompts during fallback alignment", () => {
  const typedInput = "print(1)";
  const lineText = `>>>${typedInput}`;
  const term = createFakeTerm(lineText, lineText.length);

  const result = getAlignedPrompt(term as never, typedInput, true);

  assert.equal(result.prompt.isAtPrompt, false);
  assert.equal(result.alignedTyped, null);
});

test("does not resurrect no-space mysql REPL prompts during fallback alignment", () => {
  const typedInput = "select 1";
  const lineText = `mysql>${typedInput}`;
  const term = createFakeTerm(lineText, lineText.length);

  const result = getAlignedPrompt(term as never, typedInput, true);

  assert.equal(result.prompt.isAtPrompt, false);
  assert.equal(result.alignedTyped, null);
});

test("does not resurrect host-like no-space REPL prompts during fallback alignment", () => {
  const typedInput = "select 1";
  const lineText = `user@db>${typedInput}`;
  const term = createFakeTerm(lineText, lineText.length);

  const result = getAlignedPrompt(term as never, typedInput, true);

  assert.equal(result.prompt.isAtPrompt, false);
  assert.equal(result.alignedTyped, null);
});

test("does not resurrect no-space shell continuation prompts during fallback alignment", () => {
  const typedInput = "echo ok";
  const lineText = `>${typedInput}`;
  const term = createFakeTerm(lineText, lineText.length);

  const result = getAlignedPrompt(term as never, typedInput, true);

  assert.equal(result.prompt.isAtPrompt, false);
  assert.equal(result.alignedTyped, null);
});

test("keeps typed command intact for PUA-only prompts when command text contains Powerline glyphs", () => {
  const typedInput = "echo  foo";
  const lineText = ` root  ~  ${typedInput}`;
  const term = createFakeTerm(lineText, lineText.length);

  const result = getAlignedPrompt(term as never, typedInput, true);

  assert.equal(result.prompt.isAtPrompt, true);
  assert.equal(result.prompt.promptText, " root  ~  ");
  assert.equal(result.prompt.userInput, typedInput);
  assert.equal(result.alignedTyped, typedInput);
});
