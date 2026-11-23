import assert from 'node:assert/strict';
import test from 'node:test';
import { handleCreateLocalTerminalImpl } from './AppHandlers';

type CreatedLocal = {
  shell?: string;
  shellArgs?: string[];
  shellName?: string;
  shellIcon?: string;
  localStartDir?: string;
  shellType?: string;
};

function createCtx(overrides?: {
  localShell?: string;
  localShellArgs?: string[];
  discoveredShells?: Array<{ id: string; name: string; command: string; args?: string[]; icon?: string }>;
}) {
  const created: CreatedLocal[] = [];
  const logs: Array<{ hostLabel: string }> = [];
  const localShell = overrides?.localShell ?? '';
  const localShellArgs = overrides?.localShellArgs ?? [];
  const discoveredShells = overrides?.discoveredShells ?? [];
  const getCtx = () => ({
    addConnectionLog: (entry: { hostLabel: string }) => {
      logs.push(entry);
    },
    classifyLocalShellType: () => 'unknown',
    createLocalTerminal: (options: CreatedLocal) => {
      created.push(options);
      return 'session-1';
    },
    discoveredShells,
    resolveShellSetting: (
      value: string,
      shells: Array<{ id: string; command: string; args?: string[] }>,
      customArgs?: string[],
    ) => {
      if (!value) return null;
      const match = shells.find((shell) => shell.id === value);
      if (match) {
        return { command: match.command, args: customArgs?.length ? customArgs : match.args };
      }
      return { command: value, args: customArgs?.length ? customArgs : undefined };
    },
    systemInfoRef: { current: { username: 'qi', hostname: 'box' } },
    terminalSettings: { localShell, localShellArgs },
  });
  return { getCtx, created, logs };
}

test('create local terminal resolves Settings custom absolute path when no shell arg is passed', () => {
  const custom = String.raw`C:\Users\lybing\AppData\Local\Programs\nu\bin\nu.exe`;
  const { getCtx, created } = createCtx({ localShell: custom });
  handleCreateLocalTerminalImpl(getCtx as never);
  assert.equal(created.length, 1);
  assert.equal(created[0].shell, custom);
});

test('create local terminal ignores MouseEvent-like first args and still uses Settings shell (#4085)', () => {
  const custom = String.raw`C:\Users\lybing\AppData\Local\Programs\nu\bin\nu.exe`;
  const { getCtx, created } = createCtx({ localShell: custom });
  // Vault header historically used onClick={handleCreateLocalTerminal}, so React
  // passes the click event as the first argument.
  const fakeClickEvent = { type: 'click', target: {}, preventDefault() {} };
  handleCreateLocalTerminalImpl(getCtx as never, fakeClickEvent as never);
  assert.equal(created.length, 1);
  assert.equal(created[0].shell, custom);
});

test('create local terminal still honors an explicit shell object', () => {
  const { getCtx, created } = createCtx({ localShell: 'pwsh' });
  handleCreateLocalTerminalImpl(getCtx as never, {
    command: String.raw`D:\portable\zsh\zsh.exe`,
    args: ['-l'],
    name: 'Portable Zsh',
    icon: 'zsh',
  });
  assert.equal(created.length, 1);
  assert.equal(created[0].shell, String.raw`D:\portable\zsh\zsh.exe`);
  assert.deepEqual(created[0].shellArgs, ['-l']);
  assert.equal(created[0].shellName, 'Portable Zsh');
  assert.equal(created[0].shellIcon, 'zsh');
});
