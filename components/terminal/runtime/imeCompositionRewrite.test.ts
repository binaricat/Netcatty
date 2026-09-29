import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  commitTextareaChange,
  continuedCompositionPrefix,
  keepLiveImeTranscriptionSingle,
  rememberTextareaCommit,
  type ImeCompositionCommitTarget,
} from "./imeCompositionRewrite";

const BACKSPACE = "\x7f";

test("commitTextareaChange appends the new suffix", () => {
  assert.equal(commitTextareaChange("我是真的", "我是真的牛逼"), "牛逼");
  assert.equal(commitTextareaChange("", "我是真的"), "我是真的");
  assert.equal(commitTextareaChange("ls ", "ls ，"), "，");
});

test("commitTextareaChange deletes only the diverging span", () => {
  assert.equal(commitTextareaChange("abcd", "abXY"), `${BACKSPACE}${BACKSPACE}XY`);
  assert.equal(commitTextareaChange("abcd", "ab"), `${BACKSPACE}${BACKSPACE}`);
  assert.equal(commitTextareaChange("hello", ""), BACKSPACE);
  assert.equal(commitTextareaChange("same", "same"), "");
});

test("rememberTextareaCommit grows a hypothesis and replaces a rewrite", () => {
  assert.equal(rememberTextareaCommit("", "", "我是真的"), "我是真的");
  assert.equal(rememberTextareaCommit("我是真的", "我是真的", "牛逼"), "我是真的牛逼");
  assert.equal(
    rememberTextareaCommit("abcd", "abcd", `${BACKSPACE}${BACKSPACE}XY`),
    "XY",
  );
});

test("continuedCompositionPrefix keeps a new composition after a finished line", () => {
  assert.equal(continuedCompositionPrefix(undefined, "你好"), "");
  assert.equal(
    continuedCompositionPrefix({
      continued: true,
      pendingPrevious: "hello，",
      alreadySent: "，",
      textareaAtStart: "hello，",
    }, "你好"),
    "",
  );
  assert.equal(
    continuedCompositionPrefix({
      continued: true,
      pendingPrevious: "a",
      alreadySent: "a",
      textareaAtStart: "a",
    }, "apple"),
    "",
  );
});

test("continuedCompositionPrefix returns the hypothesis already on the PTY", () => {
  assert.equal(
    continuedCompositionPrefix({
      continued: true,
      pendingPrevious: "我是真的",
      alreadySent: "我是真的",
      textareaAtStart: "我是真的牛逼",
    }, "我是真的牛逼"),
    "我是真的",
  );
  assert.equal(
    continuedCompositionPrefix({
      continued: true,
      pendingPrevious: "ls 我是真的",
      alreadySent: "我是真的",
      textareaAtStart: "ls 我是真的牛逼",
    }, "ls 我是真的牛逼"),
    "ls 我是真的",
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
  helper._textarea.value = "我是真的";
  await flushTimers();

  helper.keydown({ keyCode: 229 });
  helper._textarea.value = "我是真的牛逼";
  helper.compositionstart();
  helper.compositionend();
  await flushTimers();
  await flushTimers();

  assert.equal(helper.sent.join(""), "我是真的牛逼");
});

test("a composition range that contains only the new tail is not prefixed again", async () => {
  const helper = createHarness();
  install(helper);

  helper.keydown({ keyCode: 229 });
  helper._textarea.value = "ls 我是真的";
  await flushTimers();

  helper.keydown({ keyCode: 229 });
  helper._textarea.value = "ls 我是真的牛逼";
  helper.compositionstart();
  helper._compositionPosition = { start: "ls 我是真的".length, end: "ls 我是真的牛逼".length };
  helper.compositionend();
  await flushTimers();
  await flushTimers();

  assert.equal(helper.sent.join(""), "ls 我是真的牛逼");
});

test("a composition that only confirms the hypothesis does not append it again", async () => {
  const helper = createHarness();
  install(helper);

  helper.keydown({ keyCode: 229 });
  helper._textarea.value = "我是真的牛逼";
  await flushTimers();

  helper.keydown({ keyCode: 229 });
  helper.compositionstart();
  helper.compositionend();
  await flushTimers();
  await flushTimers();

  assert.equal(helper.sent.join(""), "我是真的牛逼");
});

test("normal compositionend still sends the committed word once", async () => {
  const helper = createHarness();
  install(helper);

  helper._textarea.value = "hello";
  helper.keydown({ keyCode: 229 });
  helper._textarea.value = "hello你";
  helper.compositionstart();
  helper._compositionPosition = { start: 5, end: 6 };
  helper.compositionend();
  await flushTimers();

  assert.deepEqual(helper.sent, ["你"]);
});

test("punctuation entered through keyCode 229 sends only the new character", async () => {
  const helper = createHarness();
  install(helper);

  helper._textarea.value = "ls ";
  helper.keydown({ keyCode: 229 });
  helper._textarea.value = "ls ，";
  await flushTimers();

  assert.deepEqual(helper.sent, ["，"]);
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

  assert.deepEqual(helper.sent, [`${BACKSPACE}${BACKSPACE}XY`]);
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
