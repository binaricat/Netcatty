import test from "node:test";
import assert from "node:assert/strict";

import {
  applyCustomAccentToTerminalTheme,
  applySessionFontSizeToHost,
  getFollowAppTerminalThemeIds,
  getFollowAppTerminalThemeSelectionUpdate,
  getFollowAppThemePickExpectedSettledId,
  isFollowAppTerminalThemeId,
  isFollowAppThemePickSettled,
  mergeTerminalHostUpdate,
  resolveFollowedTerminalThemeId,
  resolveFollowAppTerminalThemeId,
  resolveManualTerminalThemeId,
  TERMINAL_THEME_AUTO,
} from "./terminalAppearance";
import type { Host, TerminalTheme } from "./models";

const baseTheme: TerminalTheme = {
  id: "ui-snow",
  name: "Snow",
  type: "light",
  colors: {
    background: "#f1f4f8",
    foreground: "#24292f",
    cursor: "#0969da",
    selection: "#add6ff",
    black: "#24292f",
    red: "#cf222e",
    green: "#116329",
    yellow: "#9a6700",
    blue: "#0969da",
    magenta: "#8250df",
    cyan: "#0e7574",
    white: "#6e7781",
    brightBlack: "#57606a",
    brightRed: "#a40e26",
    brightGreen: "#1a7f37",
    brightYellow: "#7d4e00",
    brightBlue: "#218bff",
    brightMagenta: "#a475f9",
    brightCyan: "#0c7875",
    brightWhite: "#8c959f",
  },
};

test("applies a custom accent to terminal cursor and selection colors", () => {
  const accented = applyCustomAccentToTerminalTheme(baseTheme, "custom", "160 70% 40%");

  assert.notEqual(accented, baseTheme);
  assert.equal(accented.colors.cursor, "#1fad7e");
  assert.equal(accented.colors.selection, "#b1f1dc");
  assert.equal(baseTheme.colors.cursor, "#0969da");
  assert.equal(baseTheme.colors.selection, "#add6ff");
});

test("keeps terminal theme unchanged without a valid custom accent", () => {
  assert.equal(applyCustomAccentToTerminalTheme(baseTheme, "theme", "160 70% 40%"), baseTheme);
  assert.equal(applyCustomAccentToTerminalTheme(baseTheme, "custom", "not-a-color"), baseTheme);
});

const savedHost: Host = {
  id: "host-1",
  label: "Core switch",
  hostname: "10.0.0.2",
  username: "admin",
  port: 22,
  os: "linux",
  group: "",
  tags: [],
  protocol: "ssh",
  moshEnabled: true,
  telnetEnabled: true,
  telnetPort: 23,
};

test("terminal updates preserve saved connection protocol and port", () => {
  const telnetSessionHost: Host = {
    ...savedHost,
    protocol: "telnet",
    port: 23,
    moshEnabled: false,
    fontFamily: "jetbrains-mono",
    fontFamilyOverride: true,
  };

  const merged = mergeTerminalHostUpdate(savedHost, telnetSessionHost);

  assert.equal(merged.protocol, "ssh");
  assert.equal(merged.port, 22);
  assert.equal(merged.moshEnabled, true);
  assert.equal(merged.telnetEnabled, true);
  assert.equal(merged.telnetPort, 23);
  assert.equal(merged.fontFamily, "jetbrains-mono");
  assert.equal(merged.fontFamilyOverride, true);
});

test("terminal updates still persist credentials entered during connection", () => {
  const credentialUpdate: Host = {
    ...savedHost,
    protocol: "telnet",
    port: 23,
    moshEnabled: false,
    username: "deploy",
    authMethod: "password",
    password: "secret",
  };

  const merged = mergeTerminalHostUpdate(savedHost, credentialUpdate);

  assert.equal(merged.protocol, "ssh");
  assert.equal(merged.port, 22);
  assert.equal(merged.moshEnabled, true);
  assert.equal(merged.username, "deploy");
  assert.equal(merged.authMethod, "password");
  assert.equal(merged.password, "secret");
});

test("terminal updates still persist SFTP bookmarks", () => {
  const bookmarkUpdate: Host = {
    ...savedHost,
    protocol: "telnet",
    port: 23,
    moshEnabled: false,
    sftpBookmarks: [{ id: "bookmark-1", path: "/srv/www", label: "/srv/www" }],
  };

  const merged = mergeTerminalHostUpdate(savedHost, bookmarkUpdate);

  assert.equal(merged.protocol, "ssh");
  assert.equal(merged.port, 22);
  assert.equal(merged.moshEnabled, true);
  assert.deepEqual(merged.sftpBookmarks, [
    { id: "bookmark-1", path: "/srv/www", label: "/srv/www" },
  ]);
});

test("partial terminal updates preserve unrelated saved host fields", () => {
  const hostWithAppearance: Host = {
    ...savedHost,
    fontSize: undefined,
    fontSizeOverride: false,
    showLineTimestamps: false,
  };

  const merged = mergeTerminalHostUpdate(hostWithAppearance, {
    id: hostWithAppearance.id,
    showLineTimestamps: true,
  });

  assert.equal(merged.showLineTimestamps, true);
  assert.equal(merged.fontSize, undefined);
  assert.equal(merged.fontSizeOverride, false);
  assert.equal(merged.hostname, hostWithAppearance.hostname);
});

test("applySessionFontSizeToHost overlays workspace pane font size", () => {
  const host: Host = {
    id: "host-1",
    label: "Server",
    hostname: "example.com",
    username: "root",
    port: 22,
    group: "",
    tags: [],
  };
  const session = {
    id: "session-1",
    hostId: "host-1",
    hostLabel: "Server",
    username: "root",
    hostname: "example.com",
    status: "connected" as const,
    workspaceId: "workspace-1",
    fontSize: 18,
    fontSizeOverride: true,
  };

  const merged = applySessionFontSizeToHost(host, session);

  assert.equal(merged.fontSize, 18);
  assert.equal(merged.fontSizeOverride, true);
});

test("terminal appearance reset clears only appearance fields", () => {
  const hostWithAppearance: Host = {
    ...savedHost,
    fontSize: 16,
    fontSizeOverride: true,
  };
  const resetUpdate: Host = {
    ...hostWithAppearance,
    protocol: "telnet",
    port: 23,
    moshEnabled: false,
    fontSize: undefined,
    fontSizeOverride: false,
  };

  const merged = mergeTerminalHostUpdate(hostWithAppearance, resetUpdate);

  assert.equal(merged.protocol, "ssh");
  assert.equal(merged.port, 22);
  assert.equal(merged.moshEnabled, true);
  assert.equal(merged.fontSize, undefined);
  assert.equal(merged.fontSizeOverride, false);
});

test("follow-theme resolver: dark + auto follows the active dark UI preset", () => {
  assert.equal(
    resolveFollowedTerminalThemeId({
      resolvedTheme: "dark",
      lightUiThemeId: "snow",
      darkUiThemeId: "midnight",
      fallbackThemeId: "netcatty-dark",
    }),
    "ui-midnight",
  );
});

test("follow-theme resolver: light + auto follows the active light UI preset", () => {
  assert.equal(
    resolveFollowedTerminalThemeId({
      resolvedTheme: "light",
      lightUiThemeId: "snow",
      darkUiThemeId: "midnight",
      fallbackThemeId: "netcatty-dark",
    }),
    "ui-snow",
  );
});

test("follow-theme resolver: imported system presets follow the active light or dark mode", () => {
  assert.equal(
    resolveFollowedTerminalThemeId({
      resolvedTheme: "light",
      lightUiThemeId: "github",
      darkUiThemeId: "github",
      fallbackThemeId: "netcatty-dark",
    }),
    "system-github-light",
  );
  assert.equal(
    resolveFollowedTerminalThemeId({
      resolvedTheme: "dark",
      lightUiThemeId: "github",
      darkUiThemeId: "github",
      fallbackThemeId: "netcatty-dark",
    }),
    "system-github-dark",
  );
});

test("follow-theme resolver: explicit dark override is ignored while following app theme", () => {
  assert.equal(
    resolveFollowedTerminalThemeId({
      resolvedTheme: "dark",
      lightUiThemeId: "snow",
      darkUiThemeId: "midnight",
      fallbackThemeId: "netcatty-dark",
    }),
    "ui-midnight",
  );
});

test("manual-theme resolver: explicit per-mode theme wins when not following app theme", () => {
  assert.equal(
    resolveManualTerminalThemeId({
      resolvedTheme: "dark",
      terminalThemeDarkId: "dracula",
      terminalThemeLightId: TERMINAL_THEME_AUTO,
      lightUiThemeId: "snow",
      darkUiThemeId: "midnight",
      fallbackThemeId: "netcatty-dark",
    }),
    "dracula",
  );
  assert.equal(
    resolveManualTerminalThemeId({
      resolvedTheme: "light",
      terminalThemeDarkId: TERMINAL_THEME_AUTO,
      terminalThemeLightId: "solarized-light",
      lightUiThemeId: "snow",
      darkUiThemeId: "midnight",
      fallbackThemeId: "netcatty-dark",
    }),
    "solarized-light",
  );
});

test("manual-theme resolver: auto preserves the saved global terminal theme", () => {
  assert.equal(
    resolveManualTerminalThemeId({
      resolvedTheme: "dark",
      terminalThemeDarkId: TERMINAL_THEME_AUTO,
      terminalThemeLightId: TERMINAL_THEME_AUTO,
      lightUiThemeId: "snow",
      darkUiThemeId: "midnight",
      fallbackThemeId: "dracula",
    }),
    "dracula",
  );
});

test("follow-app sidebar pick resolves with the target mode before resolvedTheme catches up", () => {
  assert.equal(
    resolveFollowAppTerminalThemeId("system-flexoki-light", {
      resolvedTheme: "dark",
      lightUiThemeId: "flexoki",
      darkUiThemeId: "github",
      fallbackThemeId: "netcatty-dark",
    }),
    "system-flexoki-light",
  );
});

test("follow-app pick settles once ui theme and resolved mode match the selection", () => {
  assert.equal(
    isFollowAppThemePickSettled("system-flexoki-light", {
      resolvedTheme: "dark",
      lightUiThemeId: "snow",
      darkUiThemeId: "github",
      fallbackThemeId: "netcatty-dark",
    }),
    false,
  );
  assert.equal(
    isFollowAppThemePickSettled("system-flexoki-light", {
      resolvedTheme: "light",
      lightUiThemeId: "snow",
      darkUiThemeId: "github",
      fallbackThemeId: "netcatty-dark",
    }),
    false,
  );
  assert.equal(
    isFollowAppThemePickSettled("system-flexoki-light", {
      resolvedTheme: "light",
      lightUiThemeId: "flexoki",
      darkUiThemeId: "github",
      fallbackThemeId: "netcatty-dark",
    }),
    true,
  );
  assert.equal(
    getFollowAppThemePickExpectedSettledId("system-flexoki-light"),
    "system-flexoki-light",
  );
});

test("follow-app theme selection updates the matching mode and app theme", () => {
  assert.deepEqual(
    getFollowAppTerminalThemeSelectionUpdate("ui-snow"),
    {
      appTheme: "light",
      uiThemeId: "snow",
    },
  );
  assert.deepEqual(
    getFollowAppTerminalThemeSelectionUpdate("system-github-dark"),
    {
      appTheme: "dark",
      uiThemeId: "github",
    },
  );
});

test("follow-app theme list only includes terminal themes backed by UI themes", () => {
  const lightIds = getFollowAppTerminalThemeIds("light");
  const darkIds = getFollowAppTerminalThemeIds("dark");

  assert.ok(lightIds.includes("ui-snow"));
  assert.ok(lightIds.includes("system-github-light"));
  assert.ok(darkIds.includes("ui-midnight"));
  assert.ok(darkIds.includes("system-github-dark"));
  assert.equal(isFollowAppTerminalThemeId("dracula"), false);
  assert.equal(isFollowAppTerminalThemeId("custom-theme"), false);
});

test("follow-theme resolver: auto with no UI match falls back to fallbackThemeId", () => {
  assert.equal(
    resolveFollowedTerminalThemeId({
      resolvedTheme: "dark",
      lightUiThemeId: "no-such-ui-theme",
      darkUiThemeId: "no-such-ui-theme",
      fallbackThemeId: "netcatty-dark",
    }),
    "netcatty-dark",
  );
});
