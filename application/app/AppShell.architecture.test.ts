import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const appShellSource = readFileSync(join(here, 'AppShell.tsx'), 'utf8');
const appSource = readFileSync(join(here, '../../App.tsx'), 'utf8');
const vaultPublisherSource = readFileSync(join(here, 'publishers/VaultPublisher.tsx'), 'utf8');
const sessionPublisherSource = readFileSync(join(here, 'publishers/SessionPublisher.tsx'), 'utf8');
const settingsPublisherSource = readFileSync(join(here, 'publishers/SettingsPublisher.tsx'), 'utf8');
const appLockGateSource = readFileSync(join(here, '../../components/AppLockGate.tsx'), 'utf8');

const hostsDir = join(here, 'hosts');
const hostFiles = existsSync(hostsDir)
  ? readdirSync(hostsDir).filter((name) => name.endsWith('.tsx') || name.endsWith('.ts'))
  : [];
const hostSources = Object.fromEntries(
  hostFiles.map((name) => [name, readFileSync(join(hostsDir, name), 'utf8')]),
);

const MEGA_HOOKS = ['useVaultState', 'useSessionState', 'useSettingsState'] as const;
const APP_RUNTIME_HOOKS = [
  'useAppVaultRuntime',
  'useAppSessionRuntime',
  'useAppSettingsRuntime',
] as const;

test('AppShell does not co-host the vault/session/settings mega hooks', () => {
  for (const hook of MEGA_HOOKS) {
    assert.doesNotMatch(
      appShellSource,
      new RegExp(`${hook}\\s*\\(`),
      `AppShell must not call ${hook}(); Hosts subscribe to stores instead`,
    );
  }
});

test('AppShell composes the four Host islands', () => {
  assert.match(appShellSource, /<VaultHost\b/);
  assert.match(appShellSource, /<TerminalHost\b/);
  assert.match(appShellSource, /<ChromeHost\b/);
  assert.match(appShellSource, /<DialogsHost\b/);
});

test('AppShell renders the shell from store-backed bags only', () => {
  assert.match(appShellSource, /useSyncExternalStore|useAppShellProps/);
  assert.match(appShellSource, /appViewDomainsEqual/);
  assert.match(appShellSource, /<AppView domains=\{domains\} \/>/);
  assert.match(appShellSource, /<AppActiveTabChrome \{\.\.\.chrome\} \/>/);
});

test('App renders through AppShell and owns no domain bags', () => {
  assert.match(appSource, /<AppShell\b/);
  assert.doesNotMatch(appSource, /<AppView\b/);
  assert.doesNotMatch(appSource, /<AppActiveTabChrome\b/);
  assert.doesNotMatch(appSource, /<ConfirmDialog\b/);
  assert.doesNotMatch(appSource, /<PortForwardHostKeyDialog\b/);
  assert.doesNotMatch(appSource, /appVaultDomain\s*=/);
  assert.doesNotMatch(appSource, /appTerminalDomain\s*=/);
  assert.doesNotMatch(appSource, /appChromeDomain\s*=/);
  assert.doesNotMatch(appSource, /appDialogsDomain\s*=/);
});

test('App.tsx does not subscribe to vault/session/settings runtimes or mega hooks', () => {
  for (const hook of MEGA_HOOKS) {
    assert.doesNotMatch(appSource, new RegExp(`\\b${hook}\\s*\\(`));
  }
  for (const hook of APP_RUNTIME_HOOKS) {
    assert.doesNotMatch(
      appSource,
      new RegExp(`\\b${hook}\\s*\\(`),
      `App.tsx must not call ${hook}(); move subscriptions into Hosts / AppSideEffects`,
    );
  }
  assert.match(appSource, /<VaultPublisher>/);
  assert.match(appSource, /<SessionPublisher\b/);
  assert.match(appSource, /<SettingsPublisher\b/);
  assert.match(appSource, /<AppSideEffects\b/);
});

test('publishers and the app-lock gate own the mega hooks and store fan-out', () => {
  assert.match(vaultPublisherSource, /\buseVaultState\s*\(/);
  assert.match(sessionPublisherSource, /\buseSessionState\s*\(/);
  assert.match(appLockGateSource, /\buseSettingsState\s*\(/);
  assert.doesNotMatch(settingsPublisherSource, /\buseSettingsState\s*\(/);
  assert.match(settingsPublisherSource, /registerAppSettingsRuntime\(settings\)/);
  assert.match(vaultPublisherSource, /publishVaultSnapshot\(/);
  assert.match(vaultPublisherSource, /registerVaultSnapshotActions\(/);
  assert.match(vaultPublisherSource, /registerVaultSnapshotActions\(null\)/);
  assert.match(sessionPublisherSource, /publishSessionSnapshot\(/);
  assert.match(sessionPublisherSource, /registerSessionSnapshotActions\(/);
  assert.match(sessionPublisherSource, /registerSessionSnapshotActions\(null\)/);
});

test('publishers hand their runtime to App through the app runtime bridge', () => {
  assert.match(vaultPublisherSource, /registerAppVaultRuntime\(vault\)/);
  assert.match(vaultPublisherSource, /registerAppVaultRuntime\(null\)/);
  assert.match(vaultPublisherSource, /<AppVaultRuntimeContext\.Provider value=\{vaultForApp\}>/);
  assert.match(vaultPublisherSource, /notes: _notes/);
  assert.match(vaultPublisherSource, /connectionLogs: _connectionLogs/);

  assert.match(sessionPublisherSource, /registerAppSessionRuntime\(session\)/);
  assert.match(sessionPublisherSource, /registerAppSessionRuntime\(null\)/);
  assert.match(sessionPublisherSource, /<AppSessionRuntimeContext\.Provider value=\{session\}>/);

  assert.match(settingsPublisherSource, /registerAppSettingsRuntime\(settings\)/);
  assert.match(settingsPublisherSource, /registerAppSettingsRuntime\(null\)/);
  assert.match(settingsPublisherSource, /<AppSettingsRuntimeContext\.Provider value=\{settings\}>/);
});

test('VaultHost builds from vault snapshot stores', () => {
  const source = hostSources['VaultHost.tsx'];
  assert.ok(source, 'application/app/hosts/VaultHost.tsx must exist');
  assert.match(source, /useVaultSnapshot/);
  assert.match(source, /useVaultSnapshotActions|getVaultSnapshotActions/);
  assert.doesNotMatch(source, /\buseVaultState\s*\(/);
  assert.doesNotMatch(source, /\buseAppVaultRuntime\s*\(/);
});

test('TerminalHost builds from session snapshot + terminal settings store', () => {
  const source = hostSources['TerminalHost.tsx'];
  assert.ok(source, 'application/app/hosts/TerminalHost.tsx must exist');
  assert.match(source, /useSessionSnapshot/);
  assert.match(source, /useSessionSnapshotActions|getSessionSnapshotActions/);
  assert.match(source, /useTerminalSettingsStore|getTerminalSettingsSnapshot/);
  assert.doesNotMatch(source, /\buseSessionState\s*\(/);
  assert.doesNotMatch(source, /\buseAppSessionRuntime\s*\(/);
});

test('ChromeHost builds from chrome settings + session/vault snapshots', () => {
  const source = hostSources['ChromeHost.tsx'];
  assert.ok(source, 'application/app/hosts/ChromeHost.tsx must exist');
  assert.match(source, /useSettingsChromeStore|getSettingsChromeSnapshot/);
  assert.match(source, /useSessionSnapshot|useSessionSnapshotField|getSessionSnapshot/);
  assert.match(source, /useVaultSnapshot|useVaultSnapshotField|getVaultSnapshot/);
  assert.doesNotMatch(source, /\buseSettingsState\s*\(/);
  assert.doesNotMatch(source, /\buseAppSettingsRuntime\s*\(/);
});

test('DialogsHost builds from local dialog state + selective vault snapshot', () => {
  const source = hostSources['DialogsHost.tsx'];
  assert.ok(source, 'application/app/hosts/DialogsHost.tsx must exist');
  assert.match(source, /useVaultSnapshot|useVaultSnapshotField|getVaultSnapshot/);
  assert.doesNotMatch(source, /\buseVaultState\s*\(/);
  assert.doesNotMatch(source, /\buseAppVaultRuntime\s*\(/);
});

test('AppSideEffects may use runtime hooks; App must not', () => {
  const sideEffectsPath = join(here, 'AppSideEffects.tsx');
  assert.ok(existsSync(sideEffectsPath), 'application/app/AppSideEffects.tsx must exist');
  const sideEffectsSource = readFileSync(sideEffectsPath, 'utf8');
  assert.doesNotMatch(sideEffectsSource, /\bfunction App\b|\bconst App\b/);
  assert.match(
    sideEffectsSource,
    /useAppVaultRuntime|useAppSessionRuntime|useAppSettingsRuntime|getAppVaultRuntime|getAppSessionRuntime|getAppSettingsRuntime/,
  );
});

test('AppSideEffects does not build domain bags for Hosts', () => {
  const sideEffectsSource = readFileSync(join(here, 'AppSideEffects.tsx'), 'utf8');
  assert.doesNotMatch(sideEffectsSource, /appVaultDomain\s*=/);
  assert.doesNotMatch(sideEffectsSource, /appTerminalDomain\s*=/);
  assert.doesNotMatch(sideEffectsSource, /appChromeDomain\s*=/);
  assert.doesNotMatch(sideEffectsSource, /appDialogsDomain\s*=/);
  assert.doesNotMatch(sideEffectsSource, /appMountsDomain\s*=/);
  assert.doesNotMatch(sideEffectsSource, /appViewDomains\s*=/);
  assert.doesNotMatch(sideEffectsSource, /appShellChrome\s*=/);
  assert.doesNotMatch(sideEffectsSource, /appShellOverlays\s*=/);
  // Flat glue only — no prepared domain bags on the handlers bridge.
  assert.doesNotMatch(sideEffectsSource, /vaultDomain\s*:/);
  assert.doesNotMatch(sideEffectsSource, /terminalDomain\s*:/);
  assert.doesNotMatch(sideEffectsSource, /chromeDomain\s*:/);
  assert.doesNotMatch(sideEffectsSource, /dialogsDomain\s*:/);
  assert.doesNotMatch(sideEffectsSource, /mountsDomain\s*:/);
  assert.match(sideEffectsSource, /registerAppHandlers\s*\(/);
  assert.match(sideEffectsSource, /publishAppLocalUi\s*\(/);
});

test('Hosts assemble bags field-by-field without spreading prepared domains', () => {
  for (const name of ['VaultHost.tsx', 'TerminalHost.tsx', 'ChromeHost.tsx', 'DialogsHost.tsx']) {
    const source = hostSources[name];
    assert.ok(source, `application/app/hosts/${name} must exist`);
    assert.doesNotMatch(
      source,
      /handlers\?\.(vault|terminal|chrome|dialogs)Domain|handlers\?\.appShellChrome|handlers\?\.appShellOverlays/,
      `${name} must not read prepared *Domain / appShell* bags from handlers`,
    );
    assert.doesNotMatch(
      source,
      /\.\.\.\s*prepared/,
      `${name} must not spread a prepared domain bag`,
    );
    assert.match(source, /getAppHandlers|subscribeAppHandlers/);
  }
});

test('published Host bags omit notes, accent, and connectionLogs churn fields', () => {
  const vaultHost = hostSources['VaultHost.tsx'];
  const terminalHost = hostSources['TerminalHost.tsx'];
  assert.ok(vaultHost && terminalHost);

  // Notes / connection logs live in dedicated stores — VaultHost must not
  // publish them into the vault domain bag that AppView consumes.
  assert.doesNotMatch(vaultHost, /\bnotes\s*,/);
  assert.doesNotMatch(vaultHost, /\bconnectionLogs\s*,/);
  assert.doesNotMatch(vaultHost, /notesStore|connectionLogsStore|useNotesStore|useConnectionLogs/);

  // Accent feeds useThemeRuntime for local injection only; the published
  // terminal domain bag must not list accentMode/customAccent fields.
  const domainStart = terminalHost.indexOf('const terminalDomain = useMemo');
  assert.notEqual(domainStart, -1);
  const domain = terminalHost.slice(domainStart, terminalHost.indexOf('useLayoutEffect(() => {\n    if (terminalDomain)', domainStart));
  assert.doesNotMatch(domain, /accentMode/);
  assert.doesNotMatch(domain, /customAccent/);
  assert.match(domain, /currentTerminalTheme,/);
  assert.match(
    terminalHost,
    /useTerminalAppearanceInjection\(accentedGlobalAppearance/,
  );
});

test('AppShell uses default memo (store-driven), not always-rerender comparator', () => {
  assert.match(appShellSource, /memo\s*\(\s*AppShellView\s*\)/);
  assert.doesNotMatch(appShellSource, /memo\s*\(\s*AppShellView\s*,\s*\(\s*\)\s*=>\s*false\s*\)/);
});
