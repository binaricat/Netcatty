import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelMessage } from 'ai';
import {
  CROPPED_IMAGE_VISION_TOKENS,
  estimateModelMessagesTokens,
  FULL_IMAGE_VISION_TOKENS,
} from './tokenEstimator';

test('tokenEstimator assigns fixed realistic vision tokens to large user image attachments instead of counting base64 chars', () => {
  const largeJpegBase64 = 'A'.repeat(180_000);
  const messages: ModelMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What is the error on this screen?' },
        { type: 'file', data: largeJpegBase64, mediaType: 'image/jpeg', filename: 'remote-screen-rdp-full.jpg' },
      ],
    },
  ];

  const tokens = estimateModelMessagesTokens(messages, 'openai');
  assert.ok(tokens >= FULL_IMAGE_VISION_TOKENS);
  assert.ok(tokens < FULL_IMAGE_VISION_TOKENS + 100, `expected ~1200 tokens, got ${tokens}`);
});

test('tokenEstimator estimates native tool-result content images at fixed vision budgets (full vs cropped)', () => {
  const hugeBase64 = 'B'.repeat(240_000);
  const fullScreenMsg: ModelMessage[] = [
    {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'call-full',
        toolName: 'remote_desktop_read_screen',
        output: {
          type: 'content',
          value: [
            { type: 'text', text: JSON.stringify({ ok: true, sessionId: 'rdp-1', width: 1280, height: 720 }) },
            {
              type: 'file',
              mediaType: 'image/jpeg',
              data: { type: 'data', data: hugeBase64 },
              filename: 'remote-screen.jpg',
            },
          ],
        },
      }],
    } as unknown as ModelMessage,
  ];

  const croppedMsg: ModelMessage[] = [
    {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'call-crop',
        toolName: 'remote_desktop_read_screen',
        output: {
          type: 'content',
          value: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: true,
                sessionId: 'rdp-1',
                width: 480,
                height: 210,
                crop: { x: 200, y: 200, width: 250, height: 200 },
              }),
            },
            {
              type: 'file',
              mediaType: 'image/png',
              data: { type: 'data', data: hugeBase64 },
              filename: 'remote-screen.png',
            },
          ],
        },
      }],
    } as unknown as ModelMessage,
  ];

  const fullTokens = estimateModelMessagesTokens(fullScreenMsg, 'anthropic');
  const cropTokens = estimateModelMessagesTokens(croppedMsg, 'anthropic');

  assert.ok(fullTokens >= FULL_IMAGE_VISION_TOKENS && fullTokens < FULL_IMAGE_VISION_TOKENS + 200);
  assert.ok(cropTokens >= CROPPED_IMAGE_VISION_TOKENS && cropTokens < CROPPED_IMAGE_VISION_TOKENS + 200);
  assert.ok(cropTokens < fullTokens);
});
