import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import type { Identity, Host } from "../types";

async function withWizard(
  run: (fixture: Awaited<ReturnType<typeof mountWizard>>) => Promise<void>,
  identities: Identity[] = [],
) {
  const fixture = await mountWizard(identities);
  try {
    await run(fixture);
  } finally {
    await fixture.cleanup();
  }
}

async function mountWizard(identities: Identity[]) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://localhost", pretendToBeVisual: true,
  });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "MutationObserver", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "FocusEvent"] as const) {
    install(key, key === "window" ? dom.window : dom.window[key]);
  }
  install("getComputedStyle", dom.window.getComputedStyle.bind(dom.window));
  install("requestAnimationFrame", dom.window.requestAnimationFrame.bind(dom.window));
  install("cancelAnimationFrame", dom.window.cancelAnimationFrame.bind(dom.window));
  install("IS_REACT_ACT_ENVIRONMENT", true);
  const { act, useState } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { I18nProvider } = await import("../application/i18n/I18nProvider");
  const { default: QuickConnectWizard } = await import("./QuickConnectWizard");
  const target = { hostname: "example.com" };
  const connected: Host[] = [];
  const saved: Host[] = [];
  let closeCount = 0;
  function Fixture() {
    const [open, setOpen] = useState(true);
    return (
      <I18nProvider locale="en">
        {open && <QuickConnectWizard
          open target={target} keys={[]} identities={identities}
          onConnect={(host) => connected.push(host)}
          onSaveHost={(host) => saved.push(host)}
          onClose={() => { closeCount++; setOpen(false); }}
        />}
      </I18nProvider>
    );
  }
  const root = createRoot(document.getElementById("root")!);
  await act(async () => { root.render(<Fixture />); });
  const button = (name: string) => {
    const element = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.getAttribute("aria-label") === name || candidate.textContent?.trim() === name);
    assert.ok(element, `Button ${name} is present`);
    return element;
  };
  const input = (selector: string) => {
    const element = document.querySelector<HTMLInputElement>(selector);
    assert.ok(element, `Input ${selector} is present`);
    return element;
  };
  const overlay = () => {
    const element = document.querySelector<HTMLElement>(".fixed.inset-0");
    assert.ok(element, "Quick Connect is still open");
    return element;
  };
  const click = async (element: HTMLElement) => {
    await act(async () => { element.click(); });
  };
  const type = async (selector: string, value: string) => {
    await act(async () => {
      const element = input(selector);
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(element, value);
      element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    assert.equal(input(selector).value, value);
  };
  const key = async (element: HTMLElement, key: string) => {
    await act(async () => { element.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true })); });
  };
  const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); }); };
  const outsideClick = async () => {
    await act(async () => {
      overlay().dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true }));
      overlay().click();
    });
    assert.equal(closeCount, 0, "Background clicks must not close Quick Connect");
    overlay();
  };
  return {
    button, input, overlay, click, type, key, settle, outsideClick, connected, saved,
    closeCount: () => closeCount,
    async cleanup() {
      await act(async () => { root.unmount(); });
      dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("background clicks preserve each Quick Connect step and typed connection details", async () => {
  await withWizard(async (f) => {
    await f.type('input[type="number"]', "2222");
    await f.outsideClick();
    assert.equal(f.input('input[type="number"]').value, "2222");
    await f.click(f.button("Continue"));
    await f.type("#quick-username", "alice");
    await f.outsideClick();
    assert.equal(f.input("#quick-username").value, "alice");
    await f.click(f.button("Continue"));
    await f.type("#quick-password", "partly configured password");
    await f.outsideClick();
    await f.key(f.input("#quick-password"), "Escape");
    assert.equal(f.closeCount(), 0);
    assert.equal(f.input("#quick-password").value, "partly configured password");
    await f.click(f.button("Back"));
    assert.equal(f.input("#quick-username").value, "alice");
    await f.click(f.button("Back"));
    assert.equal(f.input('input[type="number"]').value, "2222");
    await f.click(f.button("Continue"));
    await f.click(f.button("Continue"));
    assert.equal(f.input("#quick-password").value, "partly configured password");
    await f.click(f.button("Continue"));
    assert.equal(f.connected.length, 1);
    assert.equal(f.connected[0].username, "alice");
    assert.equal(f.connected[0].port, 2222);
    assert.equal(f.connected[0].password, "partly configured password");
    assert.equal(f.closeCount(), 1);
    assert.equal(document.querySelector("h2"), null);
  });
});

test("the portaled credential picker retains the wizard and selected identity", async () => {
  await withWizard(async (f) => {
    await f.type('input[type="number"]', "2222");
    await f.click(f.input('[role="combobox"]'));
    await f.settle();
    const option = document.querySelector<HTMLElement>('[role="option"]');
    assert.ok(option);
    assert.equal(f.overlay().contains(option), false, "Options are portaled outside the wizard DOM");
    await f.click(option);
    assert.equal(f.closeCount(), 0);
    assert.equal(f.input('[role="combobox"]').value, "Production identity");
    assert.equal(f.input('input[type="number"]').value, "2222");
    await f.outsideClick();
    await f.click(f.button("Connect with preset"));
    assert.equal(f.connected.length, 1);
    assert.equal(f.connected[0].identityId, "identity-alice");
    assert.equal(f.connected[0].username, "alice");
    assert.equal(f.connected[0].port, 2222);
    assert.equal(f.closeCount(), 1);
  }, [{ id: "identity-alice", label: "Production identity", username: "alice", authMethod: "password", password: "preset secret", created: 1 }]);
});

test("the portaled save menu preserves credentials until explicit save and connect", async () => {
  await withWizard(async (f) => {
    await f.click(f.button("Continue"));
    await f.type("#quick-username", "alice");
    await f.key(f.input("#quick-username"), "Enter");
    await f.type("#quick-password", "secret");
    const trigger = f.button("Continue & Save");
    await f.click(trigger);
    await f.settle();
    const menuItem = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent === "Continue & Save");
    assert.ok(menuItem);
    assert.equal(f.overlay().contains(menuItem), false, "Save menu is portaled outside the wizard DOM");
    await f.click(menuItem.parentElement!);
    assert.equal(f.closeCount(), 0);
    assert.equal(f.input("#quick-password").value, "secret");
    await f.key(document.body, "Escape");
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    assert.equal(f.closeCount(), 0);
    await f.click(trigger);
    await f.settle();
    await f.outsideClick();
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    assert.equal(f.input("#quick-password").value, "secret");
    await f.click(trigger);
    await f.settle();
    const save = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent === "Continue & Save");
    assert.ok(save);
    await f.click(save);
    assert.equal(f.saved.length, 1);
    assert.equal(f.connected.length, 1);
    assert.equal(f.saved[0], f.connected[0]);
    assert.equal(f.connected[0].username, "alice");
    assert.equal(f.connected[0].password, "secret");
    assert.equal(f.closeCount(), 1);
  });
});

test("explicit Close dismisses the protocol step", async () => {
  await withWizard(async (f) => {
    await f.click(f.button("Close"));
    assert.equal(f.closeCount(), 1);
    assert.equal(document.querySelector("h2"), null);
    assert.equal(f.connected.length, 0);
  });
});

for (const step of ["username", "auth"]) {
  test(`the header X explicitly closes the ${step} step`, async () => {
    await withWizard(async (f) => {
      await f.click(f.button("Continue"));
      await f.type("#quick-username", "alice");
      if (step === "auth") {
        await f.click(f.button("Continue"));
        await f.type("#quick-password", "secret");
      }
      const close = f.button("Close");
      assert.ok(close.querySelector("svg.lucide-x"), "A visible X is provided on steps with Back");
      await f.click(close);
      assert.equal(f.closeCount(), 1);
      assert.equal(document.querySelector("h2"), null);
      assert.equal(f.connected.length, 0);
    });
  });
}
