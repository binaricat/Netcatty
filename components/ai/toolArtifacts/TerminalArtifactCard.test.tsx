import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TerminalArtifactCard } from './TerminalArtifactCard.tsx';

test('TerminalArtifactCard renders terminal context summary', () => {
  const html = renderToStaticMarkup(
    <TerminalArtifactCard
      artifact={{
        kind: 'terminal.context',
        sessionId: 'session-1',
        label: 'prod',
        range: 'tail',
        totalLines: 120,
        startLine: 100,
        endLine: 102,
        returnedLines: 3,
        hasMoreBefore: true,
        hasMoreAfter: false,
        source: 'live',
        preview: 'alpha\nbeta\ngamma',
      }}
    />,
  );

  assert.match(html, /prod/);
  assert.match(html, /lines 101-103 \/ 120/);
  assert.doesNotMatch(html, /alpha/);
});

test('TerminalArtifactCard renders terminal read errors', () => {
  const html = renderToStaticMarkup(
    <TerminalArtifactCard
      artifact={{
        kind: 'error',
        message: 'Terminal context reader is unavailable.',
      }}
    />,
  );

  assert.match(html, /Terminal read failed/);
  assert.match(html, /Terminal context reader is unavailable/);
});
