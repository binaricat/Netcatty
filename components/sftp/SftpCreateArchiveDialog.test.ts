import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import type { SftpArchiveDialogState } from "../../application/state/sftp/useSftpArchiveDialog";
import { createDomRenderer, dispatchDomEvent, flushEffects, installDomEnvironment } from "../test-support/renderReactDom";

test("archive dialog focuses its name and requires explicit overwrite activation", async (t) => {
  const env = installDomEnvironment();
  const globals = {
    MutationObserver: globalThis.MutationObserver,
    NodeFilter: globalThis.NodeFilter,
    HTMLInputElement: globalThis.HTMLInputElement,
    DocumentFragment: globalThis.DocumentFragment,
  };
  for (const key of Object.keys(globals) as Array<keyof typeof globals>) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: env.window[key] });
  }
  const { SftpCreateArchiveDialog } = await import("./SftpCreateArchiveDialog");
  const renderer = await createDomRenderer(env.document);
  t.after(async () => {
    await renderer.unmount();
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const [key, value] of Object.entries(globals)) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    env.cleanup();
  });
  let state: SftpArchiveDialogState = {
    target: { paneId: "pane-1", connectionId: "conn-1" },
    directory: "/srv", paths: ["site"], archiveName: "site.tar.gz", format: "tar.gz",
    busy: false, error: null, confirmOverwrite: false,
  };
  const submissions: Array<boolean | undefined> = [];
  let closes = 0;
  const render = () => renderer.render(React.createElement(SftpCreateArchiveDialog, {
    state,
    t: (key) => key,
    onClose: () => { closes += 1; },
    onNameChange: () => {},
    onFormatChange: () => {},
    onSubmit: async (overwrite) => { submissions.push(overwrite); },
  }));
  await render();
  await flushEffects();
  const input = env.document.querySelector("input");
  assert.ok(input);
  assert.equal(env.document.activeElement, input);
  assert.equal(input.value, "site.tar.gz");
  assert.ok(env.document.querySelector("label[for='" + input.id + "']"));
  await dispatchDomEvent(input, new env.window.KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
  assert.deepEqual(submissions, [], "confirming an IME candidate must not create an archive");
  await dispatchDomEvent(input, new env.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.deepEqual(submissions, [undefined]);
  state = { ...state, confirmOverwrite: true };
  await render();
  assert.match(env.document.querySelector('[role="alert"]')?.textContent ?? "", /sftp.archive.overwriteDescription/);
  await dispatchDomEvent(input, new env.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.deepEqual(submissions, [undefined], "Enter in the name field does not replace an existing archive");
  const overwrite = [...env.document.querySelectorAll("button")].find((button) => button.textContent === "sftp.archive.overwrite");
  assert.ok(overwrite);
  await dispatchDomEvent(overwrite, new env.window.MouseEvent("click", { bubbles: true }));
  assert.deepEqual(submissions, [undefined, true]);
  state = { ...state, busy: true };
  await render();
  assert.equal(input.disabled, true);
  assert.ok([...env.document.querySelectorAll("button")].filter((button) => button.textContent === "common.cancel" || button.textContent === "sftp.archive.creating").every((button) => button.disabled));
  await dispatchDomEvent(input, new env.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.equal(closes, 0);
});
