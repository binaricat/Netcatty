import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import type { Host } from "../domain/models";

test("host totp setup stays on the shared setting row and opens a dialog", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "http://localhost",
    pretendToBeVisual: true,
  });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  install("window", dom.window);
  install("document", dom.window.document);
  install("navigator", dom.window.navigator);
  install("HTMLElement", dom.window.HTMLElement);
  install("HTMLInputElement", dom.window.HTMLInputElement);
  install("HTMLButtonElement", dom.window.HTMLButtonElement);
  install("Element", dom.window.Element);
  install("Node", dom.window.Node);
  install("MutationObserver", dom.window.MutationObserver);
  install("Event", dom.window.Event);
  install("CustomEvent", dom.window.CustomEvent);
  install("MouseEvent", dom.window.MouseEvent);
  install("KeyboardEvent", dom.window.KeyboardEvent);
  install("FocusEvent", dom.window.FocusEvent);
  install("PointerEvent", dom.window.PointerEvent);
  install("getComputedStyle", dom.window.getComputedStyle.bind(dom.window));
  install("requestAnimationFrame", dom.window.requestAnimationFrame.bind(dom.window));
  install("cancelAnimationFrame", dom.window.cancelAnimationFrame.bind(dom.window));
  install("ResizeObserver", ResizeObserverStub);
  install("IS_REACT_ACT_ENVIRONMENT", true);
  Object.assign(dom.window, { netcatty: {} });

  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { HostTotpFields } = await import("./HostTotpFields.tsx");
  const { TooltipProvider } = await import("./ui/tooltip.tsx");

  const form = {
    id: "host-1",
    label: "Jump",
    hostname: "127.0.0.1",
    port: 22,
    username: "root",
    protocol: "ssh",
  } as Host;
  let latest = form;
  const root = createRoot(dom.window.document.getElementById("root")!);
  const t = (key: string) => key;
  try {
    await act(async () => {
      root.render(
        <TooltipProvider>
          <HostTotpFields
            t={t}
            form={latest}
            setForm={(updater) => {
              latest = typeof updater === "function" ? updater(latest) : updater;
            }}
            effectiveProtocol="ssh"
          />
        </TooltipProvider>,
      );
    });
    const markup = dom.window.document.body.innerHTML;
    assert.match(markup, /hostDetails\.totp\.setup/);
    assert.doesNotMatch(markup, /rounded-md border border-border\/60 p-3/);
    assert.equal(dom.window.document.querySelector("[role='dialog']"), null);
    assert.equal(dom.window.document.querySelector("[role='switch']"), null);

    const button = [...dom.window.document.querySelectorAll("button")]
      .find((node) => node.textContent?.includes("hostDetails.totp.setup"));
    assert.ok(button);
    await act(async () => { button.click(); });
    assert.ok(dom.window.document.body.textContent?.includes("hostDetails.totp.modalTitle"));
    assert.ok(dom.window.document.body.innerHTML.includes("hostDetails.totp.secretPlaceholder"));
    assert.equal(latest.totp, undefined);
    const fields = readFileSync(new URL("./HostTotpFields.tsx", import.meta.url), "utf8");
    assert.match(fields, /label=\{t\("hostDetails\.totp\.title"\)\}/);
    assert.match(fields, /setConfirmClear\(true\)/);
    assert.match(fields, /variant="secondary"/);
    const sections = readFileSync(new URL("./HostDetailsConnectionSections.tsx", import.meta.url), "utf8");
    const passwordAt = sections.indexOf("hostDetails.password.placeholder");
    const totpAt = sections.indexOf("<HostTotpFields");
    assert.ok(passwordAt > 0 && totpAt > passwordAt);

    // Custom prompt pattern validation loads re2js on demand and rejects invalid patterns.
    const patternInput = dom.window.document.getElementById("host-totp-pattern") as HTMLInputElement | null;
    assert.ok(patternInput);
    const valueSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set;
    assert.ok(valueSetter);
    await act(async () => {
      valueSetter.call(patternInput, "[unclosed");
      patternInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    const saveButton = [...dom.window.document.querySelectorAll("button")]
      .find((node) => node.textContent?.includes("common.save"));
    assert.ok(saveButton);
    await act(async () => {
      saveButton.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    assert.ok(dom.window.document.body.textContent?.includes("hostDetails.totp.error.pattern"));
  } finally {
    await act(async () => { root.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
