import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import React, { act, useLayoutEffect } from 'react';

import {
  publishShellHistorySnapshot,
} from '../../application/state/shellHistoryStore.ts';
import {
  SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT,
  sidePanelLiveStore,
} from '../../application/state/sidePanelLiveStore.ts';
import type { ShellHistoryEntry } from '../../domain/models.ts';
import { HistorySidePanel } from '../HistorySidePanel.tsx';
import {
  createDomRenderer,
  dispatchDomEvent,
  installDomEnvironment,
} from '../test-support/renderReactDom.tsx';
import { SidePanelHistorySlot } from './terminalLayerSidePanelSlots.tsx';

const slotsSource = readFileSync(new URL('./terminalLayerSidePanelSlots.tsx', import.meta.url), 'utf8');
const historySource = readFileSync(new URL('../HistorySidePanel.tsx', import.meta.url), 'utf8');
const listSource = readFileSync(new URL('../ui/VariableSizeVirtualList.tsx', import.meta.url), 'utf8');

function historySlotSource(): string {
  const start = slotsSource.indexOf('function SidePanelHistorySlotInner');
  const end = slotsSource.indexOf('export const SidePanelHistorySlot');
  assert.ok(start >= 0 && end > start);
  return slotsSource.slice(start, end);
}

test('history keep-alive source stays mounted and gates the shell-history subscription', () => {
  const slot = historySlotSource();
  assert.doesNotMatch(slot, /if \(!isVisible\) return null/);
  assert.match(slot, /sidePanelHiddenPanelClassName\(!isVisible\)/);
  assert.match(slot, /isVisible \? subscribeShellHistory : subscribeShellHistoryNoop/);
  assert.match(slot, /getShellHistorySnapshot,\s*getShellHistorySnapshot/);
  assert.doesNotMatch(slot, /getEmptyShellHistorySnapshot/);
  assert.equal(slot.match(/useRemoteHistoryState\(\)/g)?.length, 1);
  assert.match(slot, /isVisible=\{isVisible\}/);
  assert.match(slot, /retainedLiveRef/);
  assert.match(slot, /live !== SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT/);
  assert.doesNotMatch(historySource, /if \(!isVisible\) return null/);
  assert.match(historySource, /measureEnabled=\{isVisible\}/);
  assert.match(listSource, /remeasure/);
  assert.match(listSource, /scrollToIndex\(index, 'auto'\)/);
  assert.match(listSource, /if \(!measureEnabledRef\.current && next === 0\) return/);
  assert.doesNotMatch(historySource, /<(?:button|div)[^>]*\btitle=/);
});

const hostA = {
  id: 'host-a',
  label: 'a',
  hostname: 'a.example',
  username: 'root',
  tags: [] as string[],
  os: 'linux' as const,
  protocol: 'ssh' as const,
};
const hostB = { ...hostA, id: 'host-b', label: 'b', hostname: 'b.example' };

function shellEntry(id: string, command: string): ShellHistoryEntry {
  return {
    id,
    command,
    hostId: hostA.id,
    hostLabel: hostA.label,
    sessionId: 'sess-1',
    timestamp: 1,
  };
}

function liveSnapshot(host: typeof hostA) {
  return {
    ...SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT,
    focusedHost: host,
    focusedSessionId: 'tab-1',
    historySessionId: 'sess-1',
  };
}

let probeRenders = 0;

function HistoryProbe(props: {
  focusedHost?: { id?: string } | null;
  globalEntries?: Array<{ command?: string }>;
  isVisible?: boolean;
}) {
  probeRenders += 1;
  return React.createElement('div', {
    'data-section': 'history-probe',
    'data-host': props.focusedHost?.id ?? '',
    'data-count': String(props.globalEntries?.length ?? 0),
    'data-visible': String(!!props.isVisible),
    'data-command': (props.globalEntries ?? []).map((entry) => entry.command ?? '').join('|'),
  });
}

const historySlotCtx = {
  HistorySidePanel: HistoryProbe,
  handleHistoryPaste() {},
  handleHistoryDelete() {},
  handleHistoryClear() {},
  handleHistoryRun() {},
};

function resetHistoryStores() {
  publishShellHistorySnapshot([]);
  sidePanelLiveStore.update({ ...SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT });
}

describe('history side panel keep-alive', { concurrency: false }, () => {
  test('hidden history stays mounted and shell-history publishes do not render it', async (t) => {
    resetHistoryStores();
    probeRenders = 0;
    const dom = installDomEnvironment();
    const renderer = await createDomRenderer(dom.document);
    t.after(async () => {
      await renderer.unmount();
      dom.cleanup();
      resetHistoryStores();
    });

    sidePanelLiveStore.update(liveSnapshot(hostA));
    publishShellHistorySnapshot([shellEntry('1', 'ls')]);

    const renderSlot = (isVisible: boolean) => renderer.render(React.createElement(SidePanelHistorySlot, {
      activeTabId: 'tab-1',
      ctx: historySlotCtx,
      isVisible,
    }));

    await renderSlot(true);
    const probe = () => dom.document.querySelector('[data-section="history-probe"]') as HTMLElement | null;
    const visibleProbe = probe();
    assert.ok(visibleProbe);
    visibleProbe.dataset.keepalive = 'yes';
    assert.equal(visibleProbe.dataset.host, 'host-a');
    assert.equal(visibleProbe.dataset.count, '1');
    assert.equal(visibleProbe.dataset.visible, 'true');
    assert.doesNotMatch(visibleProbe.parentElement?.className ?? '', /\bhidden\b/);

    await act(async () => {
      publishShellHistorySnapshot([shellEntry('1', 'ls'), shellEntry('2', 'pwd')]);
    });
    assert.equal(probe()?.dataset.count, '2');
    const rendersAfterVisiblePublish = probeRenders;

    await renderSlot(false);
    const parked = probe();
    assert.ok(parked);
    assert.equal(parked.dataset.keepalive, 'yes');
    assert.equal(parked.dataset.host, 'host-a');
    assert.equal(parked.dataset.count, '2');
    assert.equal(parked.dataset.command, 'ls|pwd');
    assert.match(parked.parentElement?.className ?? '', /\bhidden\b/);
    const rendersWhileParked = probeRenders;

    await act(async () => {
      publishShellHistorySnapshot([
        shellEntry('1', 'ls'),
        shellEntry('2', 'pwd'),
        shellEntry('3', 'whoami'),
      ]);
      sidePanelLiveStore.update(liveSnapshot(hostB));
    });
    assert.equal(probeRenders, rendersWhileParked);
    assert.equal(probe()?.dataset.count, '2');
    assert.equal(probe()?.dataset.command, 'ls|pwd');
    assert.equal(probe()?.dataset.host, 'host-a');
    assert.ok(probeRenders >= rendersAfterVisiblePublish);

    await renderSlot(true);
    assert.equal(probe()?.dataset.keepalive, 'yes');
    assert.equal(probe()?.dataset.count, '3');
    assert.equal(probe()?.dataset.command, 'ls|pwd|whoami');
    assert.equal(probe()?.dataset.host, 'host-b');
    assert.equal(probe()?.dataset.visible, 'true');
    assert.doesNotMatch(probe()?.parentElement?.className ?? '', /\bhidden\b/);
  });

  test('showing history again remeasures the virtual list without remounting or refetching', async (t) => {
    const dom = installDomEnvironment();
    const renderer = await createDomRenderer(dom.document);
    const heightBox = { value: 300 };
    const resizeCallbacks: ResizeObserverCallback[] = [];
    const previousObserver = globalThis.ResizeObserver;
    const previousClientHeight = Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, 'clientHeight');
    Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() {
        return heightBox.value;
      },
    });
    class ResizeObserverStub implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = ResizeObserverStub;
    dom.window.ResizeObserver = ResizeObserverStub;
    const elementProto = dom.window.HTMLElement.prototype;
    elementProto.scrollIntoView ??= () => {};
    let fetches = 0;
    const onFetch = () => {
      fetches += 1;
    };
    const remoteEntries = Array.from({ length: 40 }, (_, index) => ({
      id: `e-${index}`,
      command: `echo ${index}`,
      source: 'bash' as const,
    }));
    const host = hostA;
    const panelProps = (isVisible: boolean, fetchedAt: number | null) => React.createElement(HistorySidePanel, {
      focusedHost: host,
      focusedSessionId: 'sess-1',
      state: {
        entries: remoteEntries,
        loading: false,
        error: null,
        fetchedAt,
      },
      globalEntries: [],
      onFetch,
      onPasteToTerminal: () => {},
      onRunInTerminal: () => {},
      isVisible,
    });
    const fireResize = () => {
      for (const callback of [...resizeCallbacks]) {
        callback([], {} as ResizeObserver);
      }
    };
    const panelOf = () => dom.document.querySelector('[data-section="history-panel"]') as HTMLElement | null;
    const rowsOf = () => panelOf()?.querySelectorAll('[role="button"]').length ?? 0;
    const scrollerOf = () => panelOf()?.querySelector('.overflow-y-auto') as HTMLDivElement | null;

    t.after(async () => {
      await renderer.unmount();
      globalThis.ResizeObserver = previousObserver;
      if (previousClientHeight) {
        Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', previousClientHeight);
      }
      dom.cleanup();
    });

    await renderer.render(panelProps(true, 1));
    await act(async () => {
      await Promise.resolve();
    });
    const panel = panelOf();
    assert.ok(panel);
    panel.dataset.keepalive = 'yes';
    const visibleRows = rowsOf();
    assert.ok(visibleRows > 8, `visible window should paint rows, got ${visibleRows}`);
    assert.equal(fetches, 0);

    const scroller = scrollerOf();
    assert.ok(scroller);
    await act(async () => {
      scroller.scrollTop = 600;
      scroller.dispatchEvent(new dom.window.Event('scroll'));
    });
    const scrolledRows = rowsOf();
    assert.ok(scrolledRows > 8);
    assert.equal(scroller.scrollTop, 600);

    heightBox.value = 0;
    await renderer.render(panelProps(false, 1));
    await act(async () => {
      const parkedScroller = scrollerOf();
      assert.ok(parkedScroller);
      parkedScroller.scrollTop = 0;
      parkedScroller.dispatchEvent(new dom.window.Event('scroll'));
      fireResize();
    });
    assert.equal(panelOf()?.dataset.keepalive, 'yes');
    assert.equal(rowsOf(), scrolledRows);
    assert.equal(fetches, 0);

    heightBox.value = 480;
    await renderer.render(panelProps(true, 1));
    await act(async () => {
      await Promise.resolve();
      fireResize();
    });
    const shown = panelOf();
    assert.ok(shown);
    assert.equal(shown.dataset.keepalive, 'yes');
    const shownScroller = scrollerOf();
    assert.ok(shownScroller);
    assert.equal(shownScroller.scrollTop, 600);
    assert.ok(rowsOf() > scrolledRows, `taller viewport should extend the window, got ${rowsOf()} then ${scrolledRows}`);
    assert.equal(fetches, 0);

    const input = shown.querySelector('input');
    assert.ok(input);
    const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set;
    assert.ok(setValue);
    setValue.call(input, 'echo 12');
    await dispatchDomEvent(input, new dom.window.Event('input', { bubbles: true }));
    assert.equal(input.value, 'echo 12');

    await renderer.render(panelProps(false, 1));
    await renderer.render(panelProps(true, 1));
    const restoredInput = panelOf()?.querySelector('input');
    assert.equal(restoredInput?.value, 'echo 12');
    assert.equal(panelOf()?.dataset.keepalive, 'yes');
    assert.equal(fetches, 0);
  });

  test('hidden history does not fetch, and showing again does not refetch a cached host', async (t) => {
    const dom = installDomEnvironment();
    const renderer = await createDomRenderer(dom.document);
    let fetches = 0;
    const onFetch = () => {
      fetches += 1;
    };
    const panelProps = (isVisible: boolean, fetchedAt: number | null) => React.createElement(HistorySidePanel, {
      focusedHost: hostA,
      focusedSessionId: 'sess-1',
      state: {
        entries: [],
        loading: false,
        error: null,
        fetchedAt,
      },
      globalEntries: [],
      onFetch,
      onPasteToTerminal: () => {},
      onRunInTerminal: () => {},
      isVisible,
    });
    t.after(async () => {
      await renderer.unmount();
      dom.cleanup();
    });

    await renderer.render(panelProps(false, null));
    assert.equal(fetches, 0);
    assert.ok(dom.document.querySelector('[data-section="history-panel"]'));

    await renderer.render(panelProps(true, null));
    assert.equal(fetches, 1);

    await renderer.render(panelProps(false, 50));
    await renderer.render(panelProps(true, 50));
    assert.equal(fetches, 1);
  });

  test('remeasure waits until a parent layout effect gives the list a real height', async (t) => {
    const dom = installDomEnvironment();
    const renderer = await createDomRenderer(dom.document);
    const heightBox = { value: 0 };
    const previousObserver = globalThis.ResizeObserver;
    const previousClientHeight = Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, 'clientHeight');
    class ResizeObserverStub implements ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = ResizeObserverStub;
    dom.window.ResizeObserver = ResizeObserverStub;
    Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() {
        return heightBox.value;
      },
    });
    // Child layout effects run before the parent. Height stays 0 until this
    // parent effect, matching the portal move out of the hidden parking host.
    function DeferredHeightHarness({ visible }: { visible: boolean }) {
      useLayoutEffect(() => {
        heightBox.value = visible ? 420 : 0;
      }, [visible]);
      return React.createElement(HistorySidePanel, {
        focusedHost: hostA,
        focusedSessionId: 'sess-1',
        state: {
          entries: Array.from({ length: 40 }, (_, index) => ({
            id: `e-${index}`,
            command: `echo ${index}`,
            source: 'bash' as const,
          })),
          loading: false,
          error: null,
          fetchedAt: 1,
        },
        globalEntries: [],
        onFetch: () => {},
        onPasteToTerminal: () => {},
        onRunInTerminal: () => {},
        isVisible: visible,
      });
    }
    const panelOf = () => dom.document.querySelector('[data-section="history-panel"]') as HTMLElement | null;
    const rowsOf = () => panelOf()?.querySelectorAll('[role="button"]').length ?? 0;
    const scrollerOf = () => panelOf()?.querySelector('.overflow-y-auto') as HTMLDivElement | null;
    t.after(async () => {
      await renderer.unmount();
      globalThis.ResizeObserver = previousObserver;
      if (previousClientHeight) {
        Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', previousClientHeight);
      }
      dom.cleanup();
    });

    await renderer.render(React.createElement(DeferredHeightHarness, { visible: true }));
    await act(async () => {
      await Promise.resolve();
    });
    assert.ok(rowsOf() > 8, `deferred remeasure should paint rows, got ${rowsOf()}`);
    const panel = panelOf();
    assert.ok(panel);
    panel.dataset.keepalive = 'yes';
    const scroller = scrollerOf();
    assert.ok(scroller);
    await act(async () => {
      scroller.scrollTop = 600;
      scroller.dispatchEvent(new dom.window.Event('scroll'));
    });
    const scrolledRows = rowsOf();

    await renderer.render(React.createElement(DeferredHeightHarness, { visible: false }));
    await act(async () => {
      const parked = scrollerOf();
      assert.ok(parked);
      parked.scrollTop = 0;
      parked.dispatchEvent(new dom.window.Event('scroll'));
    });
    assert.equal(panelOf()?.dataset.keepalive, 'yes');
    assert.equal(rowsOf(), scrolledRows);

    heightBox.value = 0;
    await renderer.render(React.createElement(DeferredHeightHarness, { visible: true }));
    await act(async () => {
      await Promise.resolve();
    });
    assert.equal(panelOf()?.dataset.keepalive, 'yes');
    assert.equal(scrollerOf()?.scrollTop, 600);
    assert.ok(rowsOf() > 8);
  });
});
