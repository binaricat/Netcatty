import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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
