import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import ChatInput from './ChatInput';
import {
  CHAT_INPUT_MAX_HEIGHT,
  CHAT_INPUT_MIN_HEIGHT,
  resolveChatInputAriaHeight,
  resolveChatInputMaxHeight,
  resolveChatInputResizeHeight,
  resolveVisibleChatInputHeight,
  resolveVisibleChatInputMaxHeight,
} from './chatInputResize';
import { TooltipProvider } from '../ui/tooltip';

test('clamps composer dragging to the usable pane height', () => {
  assert.equal(resolveChatInputMaxHeight(900), CHAT_INPUT_MAX_HEIGHT);
  assert.equal(resolveChatInputMaxHeight(180), CHAT_INPUT_MIN_HEIGHT);
  assert.equal(resolveChatInputResizeHeight(128, 500, 420, 360), 208);
  assert.equal(resolveChatInputResizeHeight(128, 500, 700, 360), CHAT_INPUT_MIN_HEIGHT);
  assert.equal(resolveChatInputResizeHeight(300, 500, 300, 360), 360);
});

test('keeps the requested composer height while the pane is temporarily hidden or constrained', () => {
  assert.equal(resolveVisibleChatInputMaxHeight(0), null);
  assert.equal(resolveVisibleChatInputMaxHeight(Number.NaN), null);
  assert.equal(resolveVisibleChatInputHeight(360, 220), 220);
  assert.equal(resolveVisibleChatInputHeight(360, 400), 360);
  assert.equal(resolveVisibleChatInputHeight(null, 400), null);
});

test('reports an accessible composer height inside the available range', () => {
  assert.equal(resolveChatInputAriaHeight(null, CHAT_INPUT_MIN_HEIGHT), CHAT_INPUT_MIN_HEIGHT);
  assert.equal(resolveChatInputAriaHeight(360, 220), 220);
  assert.equal(resolveChatInputAriaHeight(160, 220), 160);
});

test('renders an accessible composer resize handle', () => {
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <ChatInput value="" onChange={() => {}} onSend={() => {}} />
    </TooltipProvider>,
  );

  assert.match(html, /role="separator"/);
  assert.match(html, /aria-orientation="horizontal"/);
  assert.match(html, /aria-label="ai\.chat\.resizeInput"/);
  assert.match(html, /cursor-ns-resize/);
});

test('expanded composer grows the text area while keeping controls at the bottom', () => {
  const source = readFileSync(new URL('./ChatInput.tsx', import.meta.url), 'utf8');

  assert.match(source, /data-section="ai-chat-input-body"/);
  assert.match(source, /composerHeight != null \? 'flex min-h-0 flex-1 flex-col'/);
  assert.match(source, /data-section="ai-chat-input-footer"/);
  assert.match(source, /className="shrink-0/);
  assert.doesNotMatch(source, /<Expand/);
  assert.doesNotMatch(source, /setExpanded/);
});

test('parked composer closes body-portaled menus', () => {
  const source = readFileSync(new URL('./ChatInput.tsx', import.meta.url), 'utf8');
  assert.match(source, /parked = false/);
  assert.match(source, /if \(parked\) closeAllMenus\(\)/);
  assert.match(source, /becameParked/);
});

test('first keystrokes stay local so IME and Chromium spellcheck cannot stall the composer', () => {
  const source = readFileSync(new URL('./ChatInput.tsx', import.meta.url), 'utf8');
  assert.match(source, /spellCheck=\{false\}/);
  assert.match(source, /autoCorrect="off"/);
  assert.match(source, /autoCapitalize="off"/);
  assert.match(source, /nativeEvent\.isComposing/);
  assert.match(source, /onCompositionEnd=/);
  assert.match(source, /onBlur=\{\(\) => commitComposerText\(readComposerText\(\)\)\}/);
  assert.match(source, /onChangeRef\.current\(textareaRef\.current\?\.value \?\? composerTextRef\.current\)/);
  assert.doesNotMatch(source, /onSend\(\);\s*commitComposerText\(''\);/);
  assert.match(source, /defaultValue=\{value\}/);
  assert.match(source, /field-sizing-fixed/);
  assert.doesNotMatch(source, /value=\{composerText\}/);
  assert.match(source, /createComposerHasTextStore/);
  assert.match(source, /ComposerSendUi/);
  assert.match(source, /chatInputPropsAreEqual/);
});

test('composer resizing also ends when pointer capture is unexpectedly lost', () => {
  const source = readFileSync(new URL('./ChatInput.tsx', import.meta.url), 'utf8');

  assert.match(source, /resizeStartRef\.current = null;[\s\S]*releasePointerCapture/);
  assert.match(source, /onLostPointerCapture=\{handleComposerResizeEnd\}/);
});

test('virtualizes the host mention list without changing its option contract', () => {
  const source = readFileSync(new URL('./ChatInput.tsx', import.meta.url), 'utf8');

  assert.match(source, /VariableSizeVirtualList/);
  assert.match(source, /ref=\{atMentionListRef\}/);
  assert.match(source, /aria-activedescendant=\{hosts\[activeMenuIndex\] \? `at-mention-/);
  assert.match(source, /onMouseEnter=\{\(\) => setActiveMenuIndex\(idx\)\}/);
  assert.match(source, /onClick=\{\(\) => handleSelectAtMention\(host\)\}/);
  assert.match(source, /max-h-\[280px\]/);
});

test('does not render a standalone slash command toolbar button', () => {
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <ChatInput
        value=""
        onChange={() => {}}
        onSend={() => {}}
        isStreaming={false}
        disabled={false}
        agentName="Catty Agent"
        quickMessages={[{
          id: 'qm-1',
          slug: 'hello',
          name: 'Hello',
          description: 'Greeting',
          content: 'Say hello',
        }]}
      />
    </TooltipProvider>,
  );

  assert.match(html, /textarea/);
  assert.doesNotMatch(html, /aria-label="ai\.chat\.slashCommands"/);
});

test('renders separate steer and stop actions for a running Codex App Server turn', () => {
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <ChatInput
        value="change direction"
        onChange={() => {}}
        onSend={() => {}}
        onSteer={() => {}}
        onStop={() => {}}
        isStreaming
        canSteer
        lockTurnConfiguration
        disabled={false}
        agentName="Codex"
        modelPresets={[{ id: 'gpt-test', name: 'GPT Test' }]}
        selectedModelId="gpt-test"
        onModelSelect={() => {}}
      />
    </TooltipProvider>,
  );

  assert.match(html, /aria-label="ai\.codex\.steer\.addInstruction"/);
  assert.match(html, /placeholder="ai\.codex\.steer\.placeholder"/);
  assert.match(html, /aria-label="Stop"/);
  assert.match(html, /disabled=""[^>]*aria-label="ai\.chat\.selectModel"/);
});

test('allows terminal-selection-only steering submissions', () => {
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <ChatInput
        value=""
        onChange={() => {}}
        onSend={() => {}}
        onSteer={() => {}}
        onStop={() => {}}
        isStreaming
        canSteer
        disabled={false}
        agentName="Codex"
        files={[{
          id: 'terminal-selection',
          filename: 'terminal-selection.txt',
          dataUrl: 'data:text/plain;base64,dGVzdA==',
          base64Data: 'dGVzdA==',
          mediaType: 'text/plain',
          terminalSelection: true,
          lineCount: 1,
        }]}
      />
    </TooltipProvider>,
  );

  assert.match(html, /<form[^>]*data-allow-empty-submit="true"/);
  assert.match(html, /aria-label="ai\.codex\.steer\.addInstruction"/);
  assert.doesNotMatch(
    html,
    /<button[^>]*disabled=""[^>]*aria-label="ai\.codex\.steer\.addInstruction"/,
  );
});

test('renders the Catty context usage ring after the model chip', () => {
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <ChatInput
        value=""
        onChange={() => {}}
        onSend={() => {}}
        agentName="Catty Agent"
        contextUsage={{
          sessionId: 'session-1',
          inputTokens: 64_000,
          contextWindow: 128_000,
          estimated: true,
        }}
      />
    </TooltipProvider>,
  );

  assert.match(html, /role="progressbar"/);
  assert.match(html, /stroke-dasharray=/);
  assert.match(html, /stroke-dashoffset=/);
  assert.match(html, /class="h-4 w-4"/);
  assert.doesNotMatch(html, /text-\[7px\]/);
  assert.match(html, /aria-valuenow="50"/);
});

test('slash picker system commands clear the local composer', () => {
  const source = readFileSync(new URL('./ChatInput.tsx', import.meta.url), 'utf8');
  assert.match(source, /if \(command === 'stop'\) onStop\?\.\(\);\s*commitComposerText\(''\);/s);
});

test('keeps thinking on a separate chip instead of mixing it into the model list', () => {
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <ChatInput
        value=""
        onChange={() => {}}
        onSend={() => {}}
        agentName="Codex"
        modelPresets={[{
          id: 'gpt-5.5',
          name: 'GPT-5.5',
          thinkingLevels: ['low', 'medium', 'high'],
        }]}
        selectedModelId="gpt-5.5/high"
        onModelSelect={() => {}}
      />
    </TooltipProvider>,
  );

  assert.match(html, /aria-label="ai\.chat\.selectModel"/);
  assert.match(html, /aria-label="ai\.chat\.thinkingLevel"/);
  assert.match(html, />High</);
  assert.doesNotMatch(html, /GPT-5\.5 \/ High/);
});

test('Catty composer exposes a provider switcher without a mixed thinking submenu', () => {
  const source = readFileSync(new URL('./ChatInput.tsx', import.meta.url), 'utf8');
  assert.match(source, /ComposerModelPicker/);
  assert.match(source, /ComposerThinkingChip/);
  assert.match(source, /cattyReasoningLevelsForSelection/);
  assert.match(source, /if \(!thinkingLevel\) return;/);
  assert.doesNotMatch(source, /showThinkingLevels/);
});

test('Catty thinking chip is hidden for OpenAI models that reject reasoningEffort', () => {
  const openai = {
    id: 'p1',
    providerId: 'openai' as const,
    name: 'OpenAI',
    enabled: true,
  };
  const gpt4o = renderToStaticMarkup(
    <TooltipProvider>
      <ChatInput
        value=""
        onChange={() => {}}
        onSend={() => {}}
        agentName="Catty Agent"
        thinkingLevel="high"
        onThinkingLevelChange={() => {}}
        providerSwitcher={{
          providers: [openai],
          selectedProviderId: 'p1',
          selectedModelId: 'gpt-4o',
          onSelect: () => {},
        }}
      />
    </TooltipProvider>,
  );
  assert.doesNotMatch(gpt4o, /aria-label="ai\.chat\.thinkingLevel"/);

  const gpt51Chat = renderToStaticMarkup(
    <TooltipProvider>
      <ChatInput
        value=""
        onChange={() => {}}
        onSend={() => {}}
        agentName="Catty Agent"
        thinkingLevel="high"
        onThinkingLevelChange={() => {}}
        providerSwitcher={{
          providers: [openai],
          selectedProviderId: 'p1',
          selectedModelId: 'gpt-5.1-chat-latest',
          onSelect: () => {},
        }}
      />
    </TooltipProvider>,
  );
  assert.doesNotMatch(gpt51Chat, /aria-label="ai\.chat\.thinkingLevel"/);

  const gpt55 = renderToStaticMarkup(
    <TooltipProvider>
      <ChatInput
        value=""
        onChange={() => {}}
        onSend={() => {}}
        agentName="Catty Agent"
        thinkingLevel="high"
        onThinkingLevelChange={() => {}}
        providerSwitcher={{
          providers: [openai],
          selectedProviderId: 'p1',
          selectedModelId: 'gpt-5.5',
          onSelect: () => {},
        }}
      />
    </TooltipProvider>,
  );
  assert.match(gpt55, /aria-label="ai\.chat\.thinkingLevel"/);
});

test('ChatInput wires /compact through getSystemSlashCommand and canCompact', () => {
  const source = readFileSync(new URL('./ChatInput.tsx', import.meta.url), 'utf8');
  assert.match(source, /getSystemSlashCommand/);
  assert.match(source, /systemCommand === 'compact'/);
  assert.match(source, /canCompact/);
  assert.match(source, /onCompact\?\.\(\)/);
  assert.match(source, /command\.slug !== 'compact' \|\| canCompact/);
});
