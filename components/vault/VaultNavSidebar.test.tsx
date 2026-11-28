import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import type { PluginVaultNavId, VaultNavItemId } from '../../domain/vaultNavConfig';
import type { VaultNavCustomizeItem } from './VaultNavCustomizePopover';
import type { VaultNavItemDescriptor } from './VaultNavSidebar';

const DB_PLUGIN = 'plugin-vault:com.binaricat.netcatty-database.main' as const;
const MONITOR_PLUGIN = 'plugin-vault:com.binaricat.netcatty-monitor.workbench' as const;

function createDragEvent(
  win: Window & typeof globalThis,
  type: string,
  options: { clientY?: number; dataTransfer?: Record<string, unknown> } = {},
) {
  const event = new win.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clientY', { value: options.clientY ?? 0 });
  Object.defineProperty(event, 'dataTransfer', {
    value: options.dataTransfer ?? {
      types: [],
      effectAllowed: 'all',
      dropEffect: 'none',
      setData() {},
      getData() { return ''; },
    },
  });
  return event;
}

test('VaultNavSidebar supports drag-and-drop reorder (expanded + collapsed), show/hide with active fallback, and reset', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost',
  });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of [
    'window',
    'document',
    'navigator',
    'localStorage',
    'HTMLElement',
    'HTMLButtonElement',
    'HTMLInputElement',
    'Element',
    'SVGElement',
    'Node',
    'NodeFilter',
    'MutationObserver',
    'StorageEvent',
    'CustomEvent',
    'Event',
    'KeyboardEvent',
    'MouseEvent',
    'ResizeObserver',
  ]) {
    if (key === 'ResizeObserver') {
      install(key, class { observe() {} unobserve() {} disconnect() {} });
    } else {
      install(key, key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window]);
    }
  }
  install('PointerEvent', dom.window.MouseEvent);
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0));
  install('cancelAnimationFrame', (id: number) => clearTimeout(id));
  install('IS_REACT_ACT_ENVIRONMENT', true);

  // Give each nav item deterministic vertical bounds (height 40, y = index * 40).
  dom.window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const id = this.getAttribute?.('data-vault-nav-item') || this.getAttribute?.('data-vault-nav-customize-row');
    const siblings = this.parentElement ? Array.from(this.parentElement.children) : [];
    const index = Math.max(0, siblings.indexOf(this));
    const top = id ? index * 40 : 0;
    return new dom.window.DOMRect(0, top, 200, 40);
  };

  const { default: React, act, useState } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider, useI18n } = await import('../../application/i18n/I18nProvider');
  const { useVaultNavConfig } = await import('../../application/state/useVaultNavConfig');
  const {
    getVisibleVaultNavIds,
    isLockedVaultNavId,
    resolveFallbackVaultSection,
  } = await import('../../domain/vaultNavConfig');
  const { TooltipProvider } = await import('../ui/tooltip');
  const { VaultNavSidebarList } = await import('./VaultNavSidebar');
  const { VaultNavCustomizePopover } = await import('./VaultNavCustomizePopover');

  let currentSectionRef: VaultNavItemId = 'hosts';
  let setCollapsedExternally!: (collapsed: boolean) => void;
  let setPluginsExternally!: (plugins: PluginVaultNavId[]) => void;

  const LABEL_BY_ID: Record<string, string> = {
    hosts: 'Hosts',
    keys: 'Keychain',
    proxies: 'Proxies',
    port: 'Port Forwarding',
    snippets: 'Scripts',
    notes: 'Notes',
    knownhosts: 'Known Hosts',
    logs: 'Logs',
    [DB_PLUGIN]: 'Database',
    [MONITOR_PLUGIN]: 'Monitor',
  };

  function Harness() {
    const { t } = useI18n();
    const [activeSection, setActiveSection] = useState<VaultNavItemId>('hosts');
    const [collapsed, setCollapsed] = useState(false);
    const [customizeOpen, setCustomizeOpen] = useState(false);
    const [pluginIds, setPluginIds] = useState<PluginVaultNavId[]>([DB_PLUGIN, MONITOR_PLUGIN]);
    currentSectionRef = activeSection;
    setCollapsedExternally = setCollapsed;
    setPluginsExternally = setPluginIds;

    const nav = useVaultNavConfig({ activePluginIds: pluginIds, pluginsLoading: false });

    const makeDescriptor = (id: VaultNavItemId): VaultNavItemDescriptor => ({
      id,
      label: LABEL_BY_ID[id] ?? id,
      ariaLabel: id.startsWith('plugin-vault:') ? `${LABEL_BY_ID[id]} — Official` : LABEL_BY_ID[id],
      icon: <span data-icon={id} />,
      locked: isLockedVaultNavId(id),
      isPluginFallback: id === 'hosts',
      pluginName: id.startsWith('plugin-vault:') ? 'Official' : undefined,
    });

    const visibleItems = nav.visibleIds.map(makeDescriptor);
    const customizeItems: VaultNavCustomizeItem[] = nav.manageableIds.map((id) => {
      const desc = makeDescriptor(id);
      return {
        id: desc.id,
        label: desc.label,
        icon: desc.icon,
        pluginName: desc.pluginName,
        visible: !nav.isHidden(id),
        locked: desc.locked,
        canHide: nav.canHide(id),
      };
    });

    const handleHide = (id: VaultNavItemId) => {
      const next = nav.setVisible(id, false);
      if (activeSection === id) {
        setActiveSection(resolveFallbackVaultSection(activeSection, getVisibleVaultNavIds(next, pluginIds)));
      }
    };

    const handleToggle = (id: VaultNavItemId) => {
      const next = nav.toggleVisible(id);
      if (activeSection === id && next.hidden.includes(id)) {
        setActiveSection(resolveFallbackVaultSection(activeSection, getVisibleVaultNavIds(next, pluginIds)));
      }
    };

    return (
      <I18nProvider locale="en">
        <TooltipProvider delayDuration={0}>
          <VaultNavSidebarList
            items={visibleItems}
            activeSection={activeSection}
            collapsed={collapsed}
            isCustomized={nav.isCustomized}
            canHide={nav.canHide}
            onSelect={setActiveSection}
            onHide={handleHide}
            onReorder={nav.reorder}
            onMove={(id, dir) => nav.move(id, dir, nav.visibleIds)}
            onOpenCustomize={() => setCustomizeOpen(true)}
            onReset={nav.reset}
            t={t}
          />
          <VaultNavCustomizePopover
            open={customizeOpen}
            onOpenChange={setCustomizeOpen}
            collapsed={collapsed}
            items={customizeItems}
            isCustomized={nav.isCustomized}
            onToggleVisible={handleToggle}
            onReorder={nav.reorder}
            onMove={(id, dir) => nav.move(id, dir, nav.manageableIds)}
            onReset={nav.reset}
            t={t}
          />
        </TooltipProvider>
      </I18nProvider>
    );
  }

  const root = createRoot(document.getElementById('root')!);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
  const getVisibleOrder = () =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-vault-nav-item]')).map((el) =>
      el.getAttribute('data-vault-nav-item'),
    );

  try {
    await act(async () => {
      root.render(<Harness />);
      await settle();
    });

    // 1. Initial order includes built-ins (without retired built-in monitor) + plugin pages.
    assert.deepEqual(getVisibleOrder(), [
      'hosts',
      'keys',
      'proxies',
      'port',
      'snippets',
      'notes',
      'knownhosts',
      'logs',
      DB_PLUGIN,
      MONITOR_PLUGIN,
    ]);
    assert.ok(document.querySelector('[data-plugin-vault-fallback]'), 'Hosts retains plugin fallback focus marker');

    // 2. Drag Monitor plugin item before Keychain (index 1 -> top 40, midpoint 60; drop at y=45 => 'before').
    const dataStore = new Map<string, string>();
    const dt = {
      types: [] as string[],
      effectAllowed: 'all',
      dropEffect: 'none',
      setData(k: string, v: string) { dataStore.set(k, v); if (!this.types.includes(k)) this.types.push(k); },
      getData(k: string) { return dataStore.get(k) ?? ''; },
    };
    const monitorItem = document.querySelector<HTMLElement>(`[data-vault-nav-item="${MONITOR_PLUGIN}"]`)!;
    const keysItem = document.querySelector<HTMLElement>('[data-vault-nav-item="keys"]')!;

    await act(async () => {
      monitorItem.dispatchEvent(createDragEvent(dom.window, 'dragstart', { dataTransfer: dt }));
      keysItem.dispatchEvent(createDragEvent(dom.window, 'dragover', { clientY: 45, dataTransfer: dt }));
    });
    assert.equal(
      keysItem.querySelector('[data-vault-nav-drop-indicator]')?.getAttribute('data-vault-nav-drop-indicator'),
      'before',
      'drop indicator renders cleanly before target',
    );
    await act(async () => {
      keysItem.dispatchEvent(createDragEvent(dom.window, 'drop', { clientY: 45, dataTransfer: dt }));
      monitorItem.dispatchEvent(createDragEvent(dom.window, 'dragend', { dataTransfer: dt }));
    });
    assert.equal(getVisibleOrder()[1], MONITOR_PLUGIN, 'Monitor plugin moved right after Hosts');
    assert.equal(document.querySelector('[data-vault-nav-drop-indicator]'), null, 'drop indicator clears after drop');

    // 3. Collapsed mode also supports drag-and-drop ('after' target midpoint).
    await act(async () => {
      setCollapsedExternally(true);
      await settle();
    });
    const logsItem = document.querySelector<HTMLElement>('[data-vault-nav-item="logs"]')!;
    const hostsItem = document.querySelector<HTMLElement>('[data-vault-nav-item="hosts"]')!;
    await act(async () => {
      logsItem.dispatchEvent(createDragEvent(dom.window, 'dragstart', { dataTransfer: dt }));
      hostsItem.dispatchEvent(createDragEvent(dom.window, 'dragover', { clientY: 35, dataTransfer: dt }));
    });
    assert.equal(
      hostsItem.querySelector('[data-vault-nav-drop-indicator]')?.getAttribute('data-vault-nav-drop-indicator'),
      'after',
    );
    await act(async () => {
      hostsItem.dispatchEvent(createDragEvent(dom.window, 'drop', { clientY: 35, dataTransfer: dt }));
      logsItem.dispatchEvent(createDragEvent(dom.window, 'dragend', { dataTransfer: dt }));
    });
    assert.equal(getVisibleOrder()[1], 'logs', 'Logs moved after Hosts in collapsed mode');

    // 4. Select Logs, open Customize popover, toggle Logs off -> active section auto-falls back to Hosts.
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-vault-nav-item="logs"] button')!.click();
      await settle();
    });
    assert.equal(currentSectionRef, 'logs');

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-vault-nav-customize-trigger="true"]')!.click();
      await settle();
    });
    assert.ok(document.querySelector('[data-vault-nav-customize-popover="true"]'));

    // Hosts row has no hideable switch (pinned).
    const hostsRow = document.querySelector<HTMLElement>('[data-vault-nav-customize-row="hosts"]')!;
    assert.equal(hostsRow.querySelector('[role="switch"]'), null, 'Hosts is pinned and cannot be toggled off');

    // Toggle Logs off via its switch.
    const logsSwitch = document.querySelector<HTMLElement>(
      '[data-vault-nav-customize-row="logs"] [role="switch"]',
    )!;
    await act(async () => {
      logsSwitch.click();
      await settle();
    });
    assert.equal(getVisibleOrder().includes('logs'), false, 'Logs hidden from sidebar');
    assert.equal(currentSectionRef, 'hosts', 'hiding active section navigates to first visible section');

    // 5. Uninstalling DB_PLUGIN prunes it cleanly while preserving Monitor's custom slot.
    await act(async () => {
      setPluginsExternally([MONITOR_PLUGIN]);
      await settle();
    });
    assert.equal(getVisibleOrder().includes(DB_PLUGIN), false);
    assert.equal(getVisibleOrder()[1], MONITOR_PLUGIN);

    // 6. Reset to default restores Logs visibility and default order.
    const resetBtn = document.querySelector<HTMLButtonElement>('[data-vault-nav-reset="true"]')!;
    assert.equal(resetBtn.disabled, false);
    await act(async () => {
      resetBtn.click();
      await settle();
    });
    assert.deepEqual(getVisibleOrder(), [
      'hosts',
      'keys',
      'proxies',
      'port',
      'snippets',
      'notes',
      'knownhosts',
      'logs',
      MONITOR_PLUGIN,
    ]);
  } finally {
    await act(async () => {
      root.unmount();
      await settle();
    });
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('built-in Monitor is cleanly decoupled from core VaultViewLayout and VaultView', () => {
  const layoutSource = readFileSync(new URL('./VaultViewLayout.tsx', import.meta.url), 'utf8');
  const viewSource = readFileSync(new URL('../VaultView.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(layoutSource, /MonitorNavButton/, 'VaultViewLayout must not import or render MonitorNavButton');
  assert.doesNotMatch(layoutSource, /LazyMonitorPanels/, 'VaultViewLayout must not mount built-in MonitorPanels');
  assert.doesNotMatch(viewSource, /"monitor"/, 'VaultSection must not include retired built-in monitor');
});

test('all five locales define translated Vault navigation customization keys', async () => {
  const [{ default: en }, { default: es }, { default: ru }, { default: zhCN }, { default: zhTW }] =
    await Promise.all([
      import('../../application/i18n/locales/en.ts'),
      import('../../application/i18n/locales/es.ts'),
      import('../../application/i18n/locales/ru.ts'),
      import('../../application/i18n/locales/zh-CN.ts'),
      import('../../application/i18n/locales/zh-TW.ts'),
    ]);

  const keys = [
    'vault.nav.customize',
    'vault.nav.customizeHint',
    'vault.nav.hideItem',
    'vault.nav.moveUp',
    'vault.nav.moveDown',
    'vault.nav.resetDefault',
    'vault.nav.alwaysVisible',
    'vault.nav.pluginBadge',
    'vault.nav.dragToReorder',
    'vault.nav.toggleVisibility',
  ] as const;

  for (const [locale, messages] of Object.entries({ en, es, ru, 'zh-CN': zhCN, 'zh-TW': zhTW })) {
    for (const key of keys) {
      assert.ok(messages[key]?.trim(), `${locale} missing ${key}`);
      if (locale !== 'en') {
        assert.notEqual(messages[key], en[key], `${locale} left ${key} untranslated`);
      }
    }
  }
});

test('VaultNavSidebar renders plugin view badges in expanded and collapsed modes (1, 2, 99+, dot, tones)', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost',
  });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'HTMLButtonElement',
    'Element',
    'SVGElement',
    'Node',
    'NodeFilter',
    'MutationObserver',
    'CustomEvent',
    'Event',
    'KeyboardEvent',
    'MouseEvent',
    'ResizeObserver',
  ]) {
    if (key === 'ResizeObserver') {
      install(key, class { observe() {} unobserve() {} disconnect() {} });
    } else {
      install(key, key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window]);
    }
  }
  install('PointerEvent', dom.window.MouseEvent);
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0));
  install('cancelAnimationFrame', (id: number) => clearTimeout(id));
  install('IS_REACT_ACT_ENVIRONMENT', true);

  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { TooltipProvider } = await import('../ui/tooltip');
  const { VaultNavSidebarList } = await import('./VaultNavSidebar');

  const items: VaultNavItemDescriptor[] = [
    {
      id: 'hosts',
      label: 'Hosts',
      icon: <span data-icon="hosts" />,
      locked: true,
    },
    {
      id: MONITOR_PLUGIN,
      label: 'Monitor',
      ariaLabel: 'Monitor — Netcatty Monitor',
      tooltip: 'Monitor — Netcatty Monitor',
      icon: <span data-icon="monitor" />,
      locked: false,
      pluginViewId: 'com.binaricat.netcatty-monitor.workbench',
      pluginName: 'Netcatty Monitor',
      badge: {
        pluginId: 'com.binaricat.netcatty-monitor',
        viewId: 'com.binaricat.netcatty-monitor.workbench',
        count: 3,
        tone: 'danger',
        tooltip: '3 critical alerts',
      },
    },
    {
      id: DB_PLUGIN,
      label: 'Database',
      ariaLabel: 'Database — Netcatty Database',
      tooltip: 'Database — Netcatty Database',
      icon: <span data-icon="database" />,
      locked: false,
      pluginViewId: 'com.binaricat.netcatty-database.main',
      pluginName: 'Netcatty Database',
      badge: {
        pluginId: 'com.binaricat.netcatty-database',
        viewId: 'com.binaricat.netcatty-database.main',
        count: 145,
        tone: 'warning',
      },
    },
    {
      id: 'plugin-vault:com.example.sync.panel',
      label: 'Sync',
      ariaLabel: 'Sync — Example Sync',
      icon: <span data-icon="sync" />,
      locked: false,
      pluginViewId: 'com.example.sync.panel',
      pluginName: 'Example Sync',
      badge: {
        pluginId: 'com.example.sync',
        viewId: 'com.example.sync.panel',
        dot: true,
        tone: 'info',
      },
    },
  ];

  const root = createRoot(document.getElementById('root')!);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const noop = () => {};

  const renderSidebar = async (collapsed: boolean) => {
    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <VaultNavSidebarList
            items={items}
            activeSection="hosts"
            collapsed={collapsed}
            isCustomized={false}
            canHide={() => true}
            onSelect={noop}
            onHide={noop}
            onReorder={noop}
            onMove={noop}
            onOpenCustomize={noop}
            onReset={noop}
            t={(k) => k}
          />
        </TooltipProvider>,
      );
      await settle();
    });
  };

  try {
    // Expanded sidebar
    await renderSidebar(false);
    const monitorRow = document.querySelector<HTMLElement>(`[data-vault-nav-item="${MONITOR_PLUGIN}"]`)!;
    const monitorBadge = monitorRow.querySelector<HTMLElement>('[data-plugin-view-badge]')!;
    assert.equal(monitorBadge.textContent, '3');
    assert.equal(monitorBadge.getAttribute('data-plugin-view-badge-tone'), 'danger');
    assert.equal(
      monitorRow.querySelector('button')?.getAttribute('aria-label'),
      'Monitor — Netcatty Monitor (3 critical alerts)',
    );

    const dbBadge = document.querySelector<HTMLElement>(`[data-vault-nav-item="${DB_PLUGIN}"] [data-plugin-view-badge]`)!;
    assert.equal(dbBadge.textContent, '99+');
    assert.equal(dbBadge.getAttribute('data-plugin-view-badge-tone'), 'warning');

    const dotBadge = document.querySelector<HTMLElement>('[data-vault-nav-item="plugin-vault:com.example.sync.panel"] [data-plugin-view-badge]')!;
    assert.equal(dotBadge.getAttribute('data-plugin-view-badge'), 'dot');
    assert.equal(dotBadge.getAttribute('data-plugin-view-badge-tone'), 'info');
    assert.equal(dotBadge.textContent, '');

    // Collapsed icon rail
    await renderSidebar(true);
    const collapsedMonitorBadge = document.querySelector<HTMLElement>(`[data-vault-nav-item="${MONITOR_PLUGIN}"] [data-plugin-view-badge]`)!;
    assert.equal(collapsedMonitorBadge.textContent, '3');
    assert.equal(collapsedMonitorBadge.getAttribute('data-plugin-view-badge-tone'), 'danger');
    assert.ok(collapsedMonitorBadge.className.includes('absolute'), 'collapsed badge overlays the icon corner');

    const collapsedDbBadge = document.querySelector<HTMLElement>(`[data-vault-nav-item="${DB_PLUGIN}"] [data-plugin-view-badge]`)!;
    assert.equal(collapsedDbBadge.textContent, '99+');

    const collapsedDotBadge = document.querySelector<HTMLElement>('[data-vault-nav-item="plugin-vault:com.example.sync.panel"] [data-plugin-view-badge]')!;
    assert.equal(collapsedDotBadge.getAttribute('data-plugin-view-badge'), 'dot');
  } finally {
    await act(async () => {
      root.unmount();
      await settle();
    });
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
