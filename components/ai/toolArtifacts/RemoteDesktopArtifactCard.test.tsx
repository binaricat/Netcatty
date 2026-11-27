import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '../../../application/i18n/I18nProvider.tsx';
import { RemoteDesktopArtifactCard } from './RemoteDesktopArtifactCard.tsx';

test('RemoteDesktopArtifactCard renders remote_desktop_act summary card', () => {
  const html = renderToStaticMarkup(
    <I18nProvider locale="en">
      <RemoteDesktopArtifactCard
        artifact={{
          kind: 'remoteDesktop.act',
          sessionId: 'rdp-1',
          protocol: 'rdp',
          hostLabel: 'Win11 Dev',
          summary: 'Press Escape → Drag (852, 500) → (852, 700)',
          completedActions: 2,
          totalActions: 2,
          durationMs: 410,
          actionVisualKind: 'mixed',
        }}
      />
    </I18nProvider>,
  );

  assert.match(html, /Press Escape → Drag \(852, 500\) → \(852, 700\)/);
  assert.match(html, /Win11 Dev/);
  assert.match(html, /RDP/);
  assert.match(html, /2 actions/);
  assert.match(html, /410ms/);
});

test('RemoteDesktopArtifactCard renders remote_desktop_read_screen card', () => {
  const html = renderToStaticMarkup(
    <I18nProvider locale="en">
      <RemoteDesktopArtifactCard
        artifact={{
          kind: 'remoteDesktop.screen',
          sessionId: 'vnc-1',
          protocol: 'vnc',
          hostLabel: 'Ubuntu',
          width: 1280,
          height: 720,
          grid: true,
        }}
      />
    </I18nProvider>,
  );

  assert.match(html, /Read remote screen \(grid\)/);
  assert.match(html, /Ubuntu/);
  assert.match(html, /VNC/);
  assert.match(html, /1280×720/);
});

test('RemoteDesktopArtifactCard renders user-preempted and error states distinctly', () => {
  const preemptedHtml = renderToStaticMarkup(
    <I18nProvider locale="en">
      <RemoteDesktopArtifactCard
        artifact={{
          kind: 'error',
          toolKind: 'act',
          code: 'USER_PREEMPTED',
          message: 'User interacted with the remote desktop.',
        }}
      />
    </I18nProvider>,
  );
  assert.match(preemptedHtml, /Remote action paused by user/);
  assert.match(preemptedHtml, /border-amber-500/);

  const errorHtml = renderToStaticMarkup(
    <I18nProvider locale="en">
      <RemoteDesktopArtifactCard
        artifact={{
          kind: 'error',
          toolKind: 'screen',
          message: 'Session disconnected.',
        }}
      />
    </I18nProvider>,
  );
  assert.match(errorHtml, /Remote screen capture failed/);
  assert.match(errorHtml, /border-destructive/);
});

test('RemoteDesktopArtifactCard forwards Radix TooltipTrigger DOM props to the root element', () => {
  const html = renderToStaticMarkup(
    <I18nProvider locale="en">
      <RemoteDesktopArtifactCard
        artifact={{
          kind: 'remoteDesktop.act',
          sessionId: 'rdp-1',
          summary: 'Click (100, 200)',
          completedActions: 1,
          totalActions: 1,
          actionVisualKind: 'click',
        }}
        data-state="closed"
        aria-describedby="tooltip-1"
      />
    </I18nProvider>,
  );

  assert.match(html, /data-state="closed"/);
  assert.match(html, /aria-describedby="tooltip-1"/);
});
