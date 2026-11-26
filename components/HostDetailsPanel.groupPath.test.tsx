import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { I18nProvider } from '../application/i18n/I18nProvider';
import type { Host } from '../domain/models';
import HostDetailsPanel from './HostDetailsPanel';
import { HostDetailsConnectionSections } from './HostDetailsConnectionSections';
import { LocalShellHostDetailsPanel } from './LocalShellHostDetailsPanel';
import { SerialHostDetailsPanel } from './SerialHostDetailsPanel';
import { installDomEnvironment } from './test-support/renderReactDom';
import { AsidePanelFooter } from './ui/aside-panel';
import { Button } from './ui/button';
import { Combobox } from './ui/combobox';
import { Input } from './ui/input';
import { TooltipProvider } from './ui/tooltip';

type PanelKind = 'ssh' | 'local' | 'serial';
const host: Host = {
  id: 'existing', label: 'Web', hostname: 'web.example.com', username: 'root',
  password: 'test-password', authMethod: 'password', tags: [], os: 'linux',
  protocol: 'ssh', group: 'prod / web',
};

async function withPanel(
  kind: PanelKind,
  initialData: Host | undefined,
  run: (editor: {
    renderer: ReactTestRenderer;
    save: () => Promise<Host>;
    created: string[];
  }) => Promise<void>,
  groups: string[] = [],
) {
  const dom = installDomEnvironment();
  const previousRaf = globalThis.requestAnimationFrame;
  const previousCancelRaf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(0), 0) as unknown as number;
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  let renderer: ReactTestRenderer | undefined;
  let saved: Host | undefined;
  const created: string[] = [];
  const common = { onSave: (value: Host) => { saved = value; }, onCancel() {}, groups, layout: 'inline' as const };
  try {
    await act(async () => {
      renderer = create(<I18nProvider locale="en"><TooltipProvider>
        {kind === 'ssh' ? <HostDetailsPanel {...common} initialData={initialData}
          availableKeys={[]} identities={[]} terminalThemeId="default" terminalFontSize={14}
          onCreateGroup={(path) => created.push(path)} />
          : kind === 'local' ? <LocalShellHostDetailsPanel {...common} initialData={initialData} />
            : <SerialHostDetailsPanel {...common} initialData={initialData!} />}
      </TooltipProvider></I18nProvider>);
    });
    await run({
      renderer: renderer!, created,
      save: async () => {
        saved = undefined;
        await act(async () => {
          const buttons = renderer!.root.findByType(AsidePanelFooter).findAllByType(Button);
          await buttons[buttons.length - 1].props.onClick();
        });
        assert.ok(saved, 'the panel must call onSave');
        return saved;
      },
    });
  } finally {
    if (renderer) await act(async () => { renderer!.unmount(); });
    globalThis.requestAnimationFrame = previousRaf;
    globalThis.cancelAnimationFrame = previousCancelRaf;
    dom.cleanup();
  }
}

function groupPicker(renderer: ReactTestRenderer, kind: PanelKind) {
  return renderer.root.findAllByType(Combobox).find((picker) =>
    kind === 'ssh' ? picker.props.createText === 'Create Group' : picker.props.placeholder === 'Select Group',
  )!;
}

for (const kind of ['ssh', 'local', 'serial'] as const) {
  const initialData = { ...host, protocol: kind, ...(kind === 'serial' ? { hostname: 'COM3' } : {}) };
  test(`${kind} Host Details keeps the exact stored group on a label-only edit`, async () => {
    for (const group of ['prod / web', ' prod / web ', ' prod/web ']) {
      await withPanel(kind, { ...initialData, group }, async ({ renderer, save }) => {
        await act(async () => {
          renderer.root.findAllByType(Input).find((input) => input.props.value === host.label)!
            .props.onChange({ target: { value: 'Updated label' } });
        });
        const saved = await save();
        assert.equal(saved.label, 'Updated label');
        assert.equal(saved.group, group);
      });
    }
  });

  test(`${kind} Host Details normalizes an explicitly selected trimmed-equivalent group`, async () => {
    for (const group of [' prod/web ', ' prod / web ']) {
      await withPanel(kind, { ...initialData, group }, async ({ renderer, save }) => {
        await act(async () => { groupPicker(renderer, kind).props.onValueChange(group.trim()); });
        assert.equal((await save()).group, 'prod/web');
      }, [group.trim()]);
    }
  });

  test(`${kind} Host Details normalizes a changed group and allows clearing it`, async () => {
    await withPanel(kind, initialData, async ({ renderer, save }) => {
      const picker = groupPicker(renderer, kind);
      await act(async () => { picker.props.onValueChange(host.group); });
      assert.equal((await save()).group, host.group, 'reselecting the original group preserves it');
      for (const [value, expected] of [[' stage / / web ', 'stage/web'], ['', '']]) {
        await act(async () => { picker.props.onValueChange(value); });
        assert.equal((await save()).group, expected);
      }
    });
  });
}

for (const kind of ['ssh', 'local'] as const) {
  test(`${kind} Host Details normalizes a new host's group`, async () => {
    await withPanel(kind, undefined, async ({ renderer, save }) => {
      await act(async () => {
        if (kind === 'ssh') {
          const { update } = renderer.root.findByType(HostDetailsConnectionSections).props;
          update('hostname', 'web.example.com');
          update('password', 'test-password');
        }
        groupPicker(renderer, kind).props.onValueChange('prod / web');
      });
      assert.equal((await save()).group, 'prod/web');
    });
  });
}

test('Create Group normalizes paths before creation and selection, including the Combobox follow-up', async () => {
  const values = ['prod / web', 'prod//web', 'prod\\web', ' prod / web ', '/ prod / / web //'];
  for (const groups of [[], ['prod/web']]) {
    await withPanel('ssh', host, async ({ renderer, save, created }) => {
      for (const value of values) {
        const picker = groupPicker(renderer, 'ssh');
        await act(async () => { picker.props.onCreateNew(value); });
        assert.equal(groupPicker(renderer, 'ssh').props.value, 'prod/web');
        // Combobox calls both callbacks with the original input when creating.
        await act(async () => { picker.props.onValueChange(value); });
        assert.equal(groupPicker(renderer, 'ssh').props.value, 'prod/web');
        assert.equal((await save()).group, 'prod/web');
      }
      assert.deepEqual(created, groups.length ? [] : values.map(() => 'prod/web'));
      await act(async () => { groupPicker(renderer, 'ssh').props.onCreateNew(' / / \\ '); });
      assert.equal(created.length, groups.length ? 0 : values.length);
    }, groups);
  }
});

test('new-group sub-panel passes both parent and name through the same creation handler', () => {
  const source = readFileSync(new URL('./HostDetailsPanel.tsx', import.meta.url), 'utf8');
  assert.match(source, /createAndSelectGroup\(`\$\{newGroupParent\}\/\$\{newGroupName\}`\)/);
  assert.match(source, /onSave=\{handleCreateGroup\}/);
  assert.match(source, /onCreateNew=\{createAndSelectGroup\}/);
});
