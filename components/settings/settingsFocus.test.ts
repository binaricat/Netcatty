import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { settingsAnchorDomId } from "../../domain/settingsSearchCatalog.ts";
import { focusSettingsAnchor } from "./settingsFocus.ts";

function setupFocusDom(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const anchors = new Map<string, HTMLElement>();
  const focused: string[] = [];
  const scrolled: string[] = [];
  const globals = {
    document: {
      getElementById: (id: string) => anchors.get(id) ?? null,
      querySelectorAll: () => [],
      documentElement: {},
      body: {},
    },
    window: { setTimeout, clearTimeout },
    CSS: { escape: (value: string) => value },
    requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 0; },
  };
  for (const [key, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  const mount = (id: string, visible = true) => {
    const classes = new Set<string>();
    const el = {
      closest: () => null,
      checkVisibility: () => visible,
      classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) },
      matches: () => true,
      hasAttribute: () => true,
      focus: () => focused.push(id),
      scrollIntoView: () => scrolled.push(id),
    } as unknown as HTMLElement;
    anchors.set(settingsAnchorDomId(id), el);
    return classes;
  };
  return { mount, focused, scrolled };
}

test("missing search target focuses and highlights its visible parent after a short mount window", async (t) => {
  const { mount, focused, scrolled } = setupFocusDom(t);
  const parentClasses = mount("parent");
  const result = focusSettingsAnchor("child", { fallbackAnchorId: "parent", attempts: 48, delayMs: 50 });

  for (let retry = 0; retry < 3; retry += 1) t.mock.timers.tick(50);
  t.mock.timers.tick(49);
  assert.deepEqual(focused, []);
  t.mock.timers.tick(1);
  assert.equal(await result, true);
  assert.deepEqual(focused, ["parent"]);
  assert.deepEqual(scrolled, ["parent"]);
  assert.ok(parentClasses.has("settings-search-highlight"));
});

test("search focus prefers a visible primary over its fallback", async (t) => {
  const { mount, focused } = setupFocusDom(t);
  const childClasses = mount("child");
  const parentClasses = mount("parent");

  assert.equal(await focusSettingsAnchor("child", { fallbackAnchorId: "parent" }), true);
  assert.deepEqual(focused, ["child"]);
  assert.ok(childClasses.has("settings-search-highlight"));
  assert.equal(parentClasses.has("settings-search-highlight"), false);
});

test("search focus waits for a lazy primary before using a visible fallback", async (t) => {
  const { mount, focused } = setupFocusDom(t);
  mount("parent");
  const result = focusSettingsAnchor("child", { fallbackAnchorId: "parent" });
  t.mock.timers.tick(50);
  t.mock.timers.tick(50);
  mount("child");
  t.mock.timers.tick(50);

  assert.equal(await result, true);
  assert.deepEqual(focused, ["child"]);
});

test("search focus skips a hidden primary and waits for a visible fallback", async (t) => {
  const { mount, focused } = setupFocusDom(t);
  mount("child", false);
  mount("parent", false);
  const result = focusSettingsAnchor("child", { fallbackAnchorId: "parent" });
  for (let retry = 0; retry < 4; retry += 1) t.mock.timers.tick(50);
  assert.deepEqual(focused, []);
  mount("parent");
  t.mock.timers.tick(50);

  assert.equal(await result, true);
  assert.deepEqual(focused, ["parent"]);
});

test("system setting hints sit below their cards with a shared top gap", () => {
  const uiSource = readFileSync(new URL("./settings-ui.tsx", import.meta.url), "utf8");
  const systemSource = readFileSync(new URL("./tabs/SettingsSystemTab.tsx", import.meta.url), "utf8");

  assert.match(uiSource, /export const settingHintClassName = "mt-3 text-xs text-muted-foreground"/);
  assert.match(uiSource, /export const SettingHint/);
  assert.match(systemSource, /SettingHint/);
  assert.match(systemSource, /settings\.system\.crashLogs\.hint/);
  assert.doesNotMatch(
    systemSource,
    /<p className="text-xs text-muted-foreground">\s*\{t\("settings\.system\.crashLogs\.hint"\)\}/,
  );
});

test("settings search focus scrolls the content pane, not the window viewport", () => {
  const source = readFileSync(new URL("./settingsFocus.ts", import.meta.url), "utf8");
  const uiSource = readFileSync(new URL("./settings-ui.tsx", import.meta.url), "utf8");

  assert.match(source, /scrollSettingsAnchorIntoView/);
  assert.match(source, /findSettingsScrollContainer/);
  assert.match(source, /data-settings-scroll-pane/);
  assert.match(source, /preventScroll:\s*true/);
  // Viewport centering lifts the whole settings window under macOS traffic lights.
  assert.doesNotMatch(source, /block:\s*["']center["']/);
  assert.match(uiSource, /data-settings-scroll-pane/);
});

test("scrollSettingsAnchorIntoView prefers marked pane over document scroll", async () => {
  const { scrollSettingsAnchorIntoView } = await import("./settingsFocus.ts");

  const calls: Array<{ top: number; behavior?: ScrollBehavior }> = [];
  const scroller = {
    scrollHeight: 2000,
    clientHeight: 400,
    scrollTop: 0,
    getBoundingClientRect: () => ({
      top: 100,
      left: 0,
      bottom: 500,
      right: 400,
      width: 400,
      height: 400,
      x: 0,
      y: 100,
      toJSON() {
        return this;
      },
    }),
    scrollTo(opts: { top: number; behavior?: ScrollBehavior }) {
      calls.push(opts);
      this.scrollTop = opts.top;
    },
  } as unknown as HTMLElement;

  const anchor = {
    getBoundingClientRect: () => ({
      top: 700,
      left: 0,
      bottom: 760,
      right: 200,
      width: 200,
      height: 60,
      x: 0,
      y: 700,
      toJSON() {
        return this;
      },
    }),
    closest(selector: string) {
      if (selector === "[data-settings-scroll-pane]") return scroller;
      return null;
    },
    parentElement: scroller,
  } as unknown as HTMLElement;

  scrollSettingsAnchorIntoView(anchor, "auto");

  assert.equal(calls.length, 1);
  // elTopInScroller = 700 - 100 + 0 = 600; minus 24 padding → 576
  assert.equal(calls[0].top, 576);
  assert.equal(calls[0].behavior, "auto");
});
