import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  commitTextareaChange,
  continuedCompositionData,
  continuedCompositionPrefix,
  keepLiveImeTranscriptionSingle,
  rememberTextareaCommit,
  type ImeCompositionCommitTarget,
} from "./imeCompositionRewrite";

const BACKSPACE = "\x7f";

test("commitTextareaChange appends the new suffix", () => {
  assert.equal(commitTextareaChange("\u6211\u662f\u771f\u7684", "\u6211\u662f\u771f\u7684\u725b\u903c"), "\u725b\u903c");
  assert.equal(commitTextareaChange("", "\u6211\u662f\u771f\u7684"), "\u6211\u662f\u771f\u7684");
  assert.equal(commitTextareaChange("ls ", "ls \uff0c"), "\uff0c");
});

test("commitTextareaChange counts a supplementary-plane character as one grapheme", () => {
  const emoji = "\u{1F600}";
  const other = "\u{1F601}";
  assert.equal(commitTextareaChange(`a${emoji}`, "aX"), `${BACKSPACE}X`);
  assert.equal(commitTextareaChange(emoji, other), `${BACKSPACE}${other}`);
  assert.equal(commitTextareaChange(`a${emoji}`, "a"), BACKSPACE);
});

test("commitTextareaChange deletes the whole tail and retypes the new one", () => {
  assert.equal(commitTextareaChange("abcd", "abXY"), `${BACKSPACE}${BACKSPACE}XY`);
  assert.equal(commitTextareaChange("abcde", "abXde"), `${BACKSPACE}${BACKSPACE}${BACKSPACE}Xde`);
  assert.equal(commitTextareaChange("abcd", "ab"), `${BACKSPACE}${BACKSPACE}`);
  assert.equal(commitTextareaChange("hello", ""), BACKSPACE);
  assert.equal(commitTextareaChange("same", "same"), "");
});

test("rememberTextareaCommit grows a hypothesis and replaces a rewrite", () => {
  assert.equal(rememberTextareaCommit("", "", "\u6211\u662f\u771f\u7684"), "\u6211\u662f\u771f\u7684");
  assert.equal(rememberTextareaCommit("\u6211\u662f\u771f\u7684", "\u6211\u662f\u771f\u7684", "\u725b\u903c"), "\u6211\u662f\u771f\u7684\u725b\u903c");
  assert.equal(
    rememberTextareaCommit("abcd", "abcd", `${BACKSPACE}${BACKSPACE}XY`),
    "abXY",
  );
  assert.equal(
    rememberTextareaCommit("abcde", "abcde", `${BACKSPACE}${BACKSPACE}${BACKSPACE}Xde`, "abXde"),
    "abXde",
  );
  assert.equal(
    rememberTextareaCommit("a\u{1F600}", "a\u{1F600}", `${BACKSPACE}X`),
    "aX",
  );
  assert.equal(rememberTextareaCommit("hello", "hello", BACKSPACE, ""), "");
});

test("continuedCompositionPrefix keeps a new composition after a finished line", () => {
  assert.equal(continuedCompositionPrefix(undefined, "\u4f60\u597d"), "");
  assert.equal(
    continuedCompositionPrefix({
      continued: true,
      pendingPrevious: "hello\uff0c",
      alreadySent: "\uff0c",
      textareaAtStart: "hello\uff0c",
    }, "\u4f60\u597d"),
    "",
  );
  assert.equal(
    continuedCompositionPrefix({
      continued: false,
      pendingPrevious: "a",
      alreadySent: "a",
      textareaAtStart: "a",
    }, "apple"),
    "",
  );
  assert.equal(
    continuedCompositionPrefix({
      continued: true,
      pendingPrevious: "\u6211",
      alreadySent: "\u6211",
      textareaAtStart: "\u6211\u771f",
    }, "\u6211\u771f"),
    "\u6211",
  );
});

test("continuedCompositionData rewrites a revised hypothesis instead of appending it", () => {
  const marker = {
    continued: true,
    pendingPrevious: "abcde",
    alreadySent: "abcde",
    textareaAtStart: "abXde",
  };
  assert.equal(
    continuedCompositionData(marker, "abXde", "abXde", 0),
    `${BACKSPACE}${BACKSPACE}${BACKSPACE}Xde`,
  );
  // The new character starts at the caret after "hello", so this is a new
  // composition. The caller sends the slice unchanged.
  assert.equal(
    continuedCompositionData({
      continued: true,
      pendingPrevious: "hello",
      alreadySent: "",
      textareaAtStart: "hello",
    }, "\u4f60", "hello\u4f60", 5),
    null,
  );
  // In-place extension of a one-character hypothesis still strips the prefix.
  assert.equal(
    continuedCompositionData({
      continued: true,
      pendingPrevious: "\u6211",
      alreadySent: "\u6211",
      textareaAtStart: "\u6211\u771f",
    }, "\u6211\u771f", "\u6211\u771f", 0),
    "\u771f",
  );
  // A new word that merely starts with the finished character is not a prefix.
  assert.equal(
    continuedCompositionData({
      continued: true,
      pendingPrevious: "\u6211",
      alreadySent: "\u6211",
      textareaAtStart: "\u6211\u6211\u4eec",
    }, "\u6211\u4eec", "\u6211\u6211\u4eec", 1),
    null,
  );
});

test("continuedCompositionPrefix returns the hypothesis already on the PTY", () => {
  assert.equal(
    continuedCompositionPrefix({
      continued: true,
      pendingPrevious: "\u6211\u662f\u771f\u7684",
      alreadySent: "\u6211\u662f\u771f\u7684",
      textareaAtStart: "\u6211\u662f\u771f\u7684\u725b\u903c",
    }, "\u6211\u662f\u771f\u7684\u725b\u903c"),
    "\u6211\u662f\u771f\u7684",
  );
  assert.equal(
    continuedCompositionPrefix({
      continued: true,
      pendingPrevious: "ls \u6211\u662f\u771f\u7684",
      alreadySent: "\u6211\u662f\u771f\u7684",
      textareaAtStart: "ls \u6211\u662f\u771f\u7684\u725b\u903c",
    }, "ls \u6211\u662f\u771f\u7684\u725b\u903c"),
    "ls \u6211\u662f\u771f\u7684",
  );
});

type Harness = ImeCompositionCommitTarget & {
  compositionstart: () => void;
  compositionend: () => void;
  keydown: (event: { keyCode: number }) => boolean;
  sent: string[];
};

function createHarness(): Harness {
  const sent: string[] = [];
  const helper: Harness = {
    _textarea: { value: "" },
    _compositionView: { classList: { remove() {} } },
    _isComposing: false,
    _isSendingComposition: false,
    _compositionPosition: { start: 0, end: 0 },
    _compositionSuffix: "",
    _dataAlreadySent: "",
    _coreService: {
      triggerDataEvent(data: string) {
        sent.push(data);
      },
    },
    sent,
    compositionstart() {
      this._isComposing = true;
      this._compositionPosition = { start: 0, end: this._textarea.value.length };
      this._compositionSuffix = "";
      this._dataAlreadySent = "";
      this._compositionView.classList.remove("active");
    },
    compositionend() {
      this._finalizeComposition?.(true);
    },
    keydown(event) {
      if (this._isComposing || this._isSendingComposition) {
        if (event.keyCode === 229 || event.keyCode === 16) return false;
        this._finalizeComposition?.(false);
      }
      if (event.keyCode === 229) {
        this._handleAnyTextareaChanges?.();
        return false;
      }
      return true;
    },
  };
  return helper;
}

function install(helper: Harness): void {
  keepLiveImeTranscriptionSingle({ _core: { _compositionHelper: helper } });
}

async function flushTimers(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("live transcription of one sentence is written once", async () => {
  const helper = createHarness();
  install(helper);

  helper.keydown({ keyCode: 229 });
  helper._textarea.value = "\u6211\u662f\u771f\u7684";
  await flushTimers();

  helper.keydown({ keyCode: 229 });
  helper._textarea.value = "\u6211\u662f\u771f\u7684\u725b\u903c";
  helper.compositionstart();
  helper.compositionend();
  await flushTimers();
  await flushTimers();

  assert.equal(helper.sent.join(""), "\u6211\u662f\u771f\u7684\u725b\u903c");
});

test("a composition range that contains only the new tail is not prefixed again", async () => {
  const helper = createHarness();
  install(helper);

  helper.keydown({ keyCode: 229 });
  helper._textarea.value = "ls \u6211\u662f\u771f\u7684";
  await flushTimers();

  helper.keydown({ keyCode: 229 });
  helper._textarea.value = "ls \u6211\u662f\u771f\u7684\u725b\u903c";
  helper.compositionstart();
  helper._compositionPosition = { start: "ls \u6211\u662f\u771f\u7684".length, end: "ls \u6211\u662f\u771f\u7684\u725b\u903c".length };
  helper.compositionend();
  await flushTimers();
  await flushTimers();

  assert.equal(helper.sent.join(""), "ls \u6211\u662f\u771f\u7684\u725b\u903c");
});

test("a composition that only confirms the hypothesis does not append it again", async () => {
  const helper = createHarness();
  install(helper);

  helper.keydown({ keyCode: 229 });
  helper._textarea.value = "\u6211\u662f\u771f\u7684\u725b\u903c";
  await flushTimers();

  helper.keydown({ keyCode: 229 });
  helper.compositionstart();
  helper.compositionend();
  await flushTimers();
  await flushTimers();

  assert.equal(helper.sent.join(""), "\u6211\u662f\u771f\u7684\u725b\u903c");
});

test("normal compositionend still sends the committed word once", async () => {
  const helper = createHarness();
  install(helper);

  helper._textarea.value = "hello";
  helper.keydown({ keyCode: 229 });
  helper._textarea.value = "hello\u4f60";
  helper.compositionstart();
  helper._compositionPosition = { start: 5, end: 6 };
  helper.compositionend();
  await flushTimers();

  assert.deepEqual(helper.sent, ["\u4f60"]);
});

test("punctuation entered through keyCode 229 sends only the new character", async () => {
  const helper = createHarness();
  install(helper);

  helper._textarea.value = "ls ";
  helper.keydown({ keyCode: 229 });
  helper._textarea.value = "ls \uff0c";
  await flushTimers();

  assert.deepEqual(helper.sent, ["\uff0c"]);
});

test("keydown text already sent is not repeated on compositionend", async () => {
  const helper = createHarness();
  install(helper);

  helper.keydown({ keyCode: 229 });
  helper._textarea.value = "abc";
  await flushTimers();
  helper._compositionPosition = { start: 0, end: 4 };
  helper._textarea.value = "abcd";
  helper.compositionend();
  await flushTimers();

  assert.equal(helper.sent.join(""), "abcd");
});

test("a rewritten hypothesis is not sent again on markerless compositionend", async () => {
  const helper = createHarness();
  install(helper);

  helper.keydown({ keyCode: 229 });
  helper._textarea.value = "abcde";
  await flushTimers();

  helper.keydown({ keyCode: 229 });
  helper._textarea.value = "abXde";
  await flushTimers();

  helper._compositionPosition = { start: 0, end: "abXde".length };
  helper.compositionend();
  await flushTimers();

  assert.deepEqual(helper.sent, ["abcde", BACKSPACE, BACKSPACE, BACKSPACE, "Xde"]);
});

test("an equal-length rewrite does not resend the shared prefix", async () => {
  const helper = createHarness();
  install(helper);

  helper.keydown({ keyCode: 229 });
  helper._textarea.value = "abcd";
  await flushTimers();
  helper.sent.length = 0;

  helper.keydown({ keyCode: 229 });
  helper._textarea.value = "abXY";
  await flushTimers();

  assert.deepEqual(helper.sent, [BACKSPACE, BACKSPACE, "XY"]);
});

test("a revised composition replaces the hypothesis already on the PTY", async () => {
  const helper = createHarness();
  install(helper);

  helper.keydown({ keyCode: 229 });
  helper._textarea.value = "abcde";
  await flushTimers();

  helper.keydown({ keyCode: 229 });
  helper._textarea.value = "abXde";
  helper.compositionstart();
  helper.compositionend();
  await flushTimers();
  await flushTimers();

  assert.deepEqual(helper.sent, ["abcde", BACKSPACE, BACKSPACE, BACKSPACE, "Xde"]);
});

test("a one-character hypothesis is not repeated when composition extends it", async () => {
  const helper = createHarness();
  install(helper);

  helper.keydown({ keyCode: 229 });
  helper._textarea.value = "\u6211";
  await flushTimers();

  helper.keydown({ keyCode: 229 });
  helper._textarea.value = "\u6211\u771f";
  helper.compositionstart();
  helper.compositionend();
  await flushTimers();
  await flushTimers();

  assert.equal(helper.sent.join(""), "\u6211\u771f");
});

test("a new word that shares a prefix with a finished character is sent whole", async () => {
  const helper = createHarness();
  install(helper);

  helper.keydown({ keyCode: 229 });
  helper._textarea.value = "\u6211";
  await flushTimers();

  helper.keydown({ keyCode: 229 });
  helper._textarea.value = "\u6211\u6211\u4eec";
  helper.compositionstart();
  helper._compositionPosition = { start: 1, end: "\u6211\u6211\u4eec".length };
  helper.compositionend();
  await flushTimers();
  await flushTimers();

  assert.equal(helper.sent.join(""), "\u6211\u6211\u4eec");
});

test("keepLiveImeTranscriptionSingle is a no-op without a composition helper", () => {
  assert.doesNotThrow(() => keepLiveImeTranscriptionSingle({}));
  const helper = createHarness();
  install(helper);
  install(helper);
  assert.equal(helper.__ncImeCommitInstalled, true);
});

test("createXTermRuntime installs the guard after the composition helper exists", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "createXTermRuntime.ts"),
    "utf8",
  );
  const openAt = source.indexOf("term.open(ctx.container);");
  const installAt = source.indexOf("keepLiveImeTranscriptionSingle(term);");
  assert.ok(openAt >= 0);
  assert.ok(installAt > openAt);
});
