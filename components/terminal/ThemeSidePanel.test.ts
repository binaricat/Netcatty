import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./ThemeSidePanel.tsx", import.meta.url), "utf8");

test("theme side panel keeps theme selection visible while following app theme", () => {
  assert.doesNotMatch(source, /const \[activeTab, setActiveTab\] = useState<TabType>\(followAppTerminalTheme \? 'font' : 'theme'\)/);
  assert.doesNotMatch(source, /!\s*themeEditingLocked\s*&&\s*\(\s*<button[\s\S]*?terminal\.themeModal\.tab\.theme/);
});

test("hidden selected theme uses the normal theme item row", () => {
  assert.match(source, /hiddenSelectedTheme && \(\s*<ThemeItem/);
  assert.doesNotMatch(source, /terminal\.hiddenTheme\.title[\s\S]*terminal\.hiddenTheme\.desc/);
});
