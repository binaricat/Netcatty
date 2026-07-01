import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getFollowAppTerminalThemeIds,
  getFollowAppTerminalThemeSelectionUpdate,
} from './terminalAppearance';
import {
  idleThemeUserIntent,
  isFollowAppIntentSettled,
  pickingThemeUserIntent,
  resolveGlobalTerminalAppearance,
  resolveSessionAppearanceThemeId,
  resolveTerminalAppearance,
} from './terminalAppearanceRuntime';
import type { Host } from './models';

const baseSettings = {
  terminalThemeId: 'netcatty-dark',
  terminalThemeDarkId: 'auto',
  terminalThemeLightId: 'auto',
  followAppTerminalTheme: true,
  resolvedTheme: 'dark' as const,
  lightUiThemeId: 'snow',
  darkUiThemeId: 'github',
  accentMode: 'theme' as const,
  customAccent: '',
};

test('follow-app intent resolves to the picked theme before ui settings catch up', () => {
  const appearance = resolveGlobalTerminalAppearance({
    userIntent: pickingThemeUserIntent('system-flexoki-light'),
    settings: {
      ...baseSettings,
      resolvedTheme: 'dark',
      lightUiThemeId: 'snow',
    },
    customThemes: [],
  });

  assert.equal(appearance.themeId, 'system-flexoki-light');
  assert.equal(appearance.source, 'intent');
  assert.equal(appearance.appThemeUpdate?.uiThemeId, 'flexoki');
  assert.equal(appearance.appThemeUpdate?.appTheme, 'light');
});

test('follow-app idle resolves from active ui preset', () => {
  const appearance = resolveGlobalTerminalAppearance({
    userIntent: idleThemeUserIntent(),
    settings: baseSettings,
    customThemes: [],
  });

  assert.equal(appearance.themeId, 'system-github-dark');
  assert.equal(appearance.source, 'follow-app');
});

test('follow-app intent settled requires ui theme id and resolved theme', () => {
  assert.equal(
    isFollowAppIntentSettled('system-flexoki-light', {
      ...baseSettings,
      resolvedTheme: 'dark',
      lightUiThemeId: 'snow',
    }),
    false,
  );
  assert.equal(
    isFollowAppIntentSettled('system-flexoki-light', {
      ...baseSettings,
      resolvedTheme: 'light',
      lightUiThemeId: 'snow',
    }),
    false,
  );
  assert.equal(
    isFollowAppIntentSettled('system-flexoki-light', {
      ...baseSettings,
      resolvedTheme: 'light',
      lightUiThemeId: 'flexoki',
    }),
    true,
  );
});

test('all follow-app theme ids round-trip through intent resolution', () => {
  for (const themeId of getFollowAppTerminalThemeIds()) {
    const selection = getFollowAppTerminalThemeSelectionUpdate(themeId);
    assert.ok(selection, `missing selection for ${themeId}`);
    const appearance = resolveGlobalTerminalAppearance({
      userIntent: pickingThemeUserIntent(themeId),
      settings: {
        ...baseSettings,
        resolvedTheme: selection.appTheme,
        lightUiThemeId: selection.appTheme === 'light' ? selection.uiThemeId : 'snow',
        darkUiThemeId: selection.appTheme === 'dark' ? selection.uiThemeId : 'github',
      },
      customThemes: [],
    });
    assert.equal(appearance.themeId, themeId);
  }
});

test('manual mode uses host override when idle', () => {
  const host = {
    id: 'host-1',
    theme: 'dracula',
    themeOverride: true,
  } as Host;

  const appearance = resolveTerminalAppearance({
    userIntent: idleThemeUserIntent(),
    settings: {
      ...baseSettings,
      followAppTerminalTheme: false,
      terminalThemeDarkId: 'netcatty-dark',
    },
    hostScope: { host, isEphemeral: false },
    customThemes: [],
  });

  assert.equal(appearance.themeId, 'dracula');
  assert.equal(appearance.source, 'host-override');
});

test('manual mode intent overrides host theme while picking', () => {
  const host = {
    id: 'host-1',
    theme: 'dracula',
    themeOverride: true,
  } as Host;

  const appearance = resolveTerminalAppearance({
    userIntent: pickingThemeUserIntent('solarized-light', { scopeHostId: 'host-1' }),
    settings: {
      ...baseSettings,
      followAppTerminalTheme: false,
    },
    hostScope: { host, isEphemeral: false },
    customThemes: [],
  });

  assert.equal(appearance.themeId, 'solarized-light');
  assert.equal(appearance.source, 'intent');
});

test('manual mode intent stays scoped to the picked host', () => {
  const focusedHost = {
    id: 'host-1',
    theme: 'dracula',
    themeOverride: true,
  } as Host;
  const otherHost = {
    id: 'host-2',
    theme: 'netcatty-dark',
    themeOverride: true,
  } as Host;

  const intent = pickingThemeUserIntent('solarized-light', { scopeHostId: 'host-1' });

  assert.equal(resolveTerminalAppearance({
    userIntent: intent,
    settings: { ...baseSettings, followAppTerminalTheme: false },
    hostScope: { host: focusedHost, isEphemeral: false },
    customThemes: [],
  }).themeId, 'solarized-light');

  assert.equal(resolveTerminalAppearance({
    userIntent: intent,
    settings: { ...baseSettings, followAppTerminalTheme: false },
    hostScope: { host: otherHost, isEphemeral: false },
    customThemes: [],
  }).themeId, 'netcatty-dark');
});

test('follow-app session appearance ignores host override', () => {
  const host = {
    id: 'host-1',
    theme: 'dracula',
    themeOverride: true,
  } as Host;

  assert.equal(
    resolveSessionAppearanceThemeId(true, 'system-chai-light', host),
    'system-chai-light',
  );
  assert.equal(
    resolveSessionAppearanceThemeId(false, 'netcatty-dark', host),
    'dracula',
  );
});
