import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../../application/i18n/I18nProvider';
import { CodexUserInputCard } from './CodexUserInputCard';

test('CodexUserInputCard renders options, free-form input, and auto-resolution guidance', () => {
  const markup = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { locale: 'en' },
      React.createElement(CodexUserInputCard, {
        interaction: {
          interactionId: 'input-1',
          source: 'codex-app-server',
          kind: 'user-input',
          requestId: 'request-1',
          chatSessionId: 'chat-1',
          autoResolutionMs: 60_000,
          questions: [{
            id: 'mode',
            header: 'Mode',
            question: 'Choose a mode',
            isOther: true,
            isSecret: false,
            options: [{ label: 'Safe', description: 'Use the safe path' }],
          }],
        },
        onSubmit: () => {},
        onSkip: () => {},
      }),
    ),
  );
  assert.match(markup, /Codex needs your input/);
  assert.match(markup, /Choose a mode/);
  assert.match(markup, /Use the safe path/);
  assert.match(markup, /Enter another answer/);
  assert.match(markup, /continue automatically/);
});

test('CodexUserInputCard uses OpenCode copy for opencode question interactions', () => {
  const markup = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { locale: 'en' },
      React.createElement(CodexUserInputCard, {
        interaction: {
          interactionId: 'opencode_question_req-1',
          source: 'opencode',
          kind: 'user-input',
          requestId: 'req-1',
          chatSessionId: 'chat-1',
          questions: [{
            id: 'q0',
            header: 'Pick',
            question: 'Continue?',
            isOther: false,
            isSecret: false,
            options: [{ label: 'Yes', description: 'Keep going' }],
          }],
        },
        onSubmit: () => {},
        onSkip: () => {},
      }),
    ),
  );
  assert.match(markup, /OpenCode needs your input/);
  assert.match(markup, /Continue\?/);
  assert.match(markup, /Keep going/);
  assert.doesNotMatch(markup, /Codex needs your input/);
});
