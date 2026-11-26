import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { enSystemManagerMessages } from '../../application/i18n/locales/en/systemManager.ts';
import { esSystemManagerMessages } from '../../application/i18n/locales/es/systemManager.ts';
import { ruSystemManagerMessages } from '../../application/i18n/locales/ru/systemManager.ts';
import { zhCnSystemManagerMessages } from '../../application/i18n/locales/zh-CN/systemManager.ts';
import { zhTwSystemManagerMessages } from '../../application/i18n/locales/zh-TW/systemManager.ts';

test('PortsManagerTab and QuickPortForwardDialog i18n keys exist across all five locales', () => {
  const portsSource = readFileSync(new URL('./PortsManagerTab.tsx', import.meta.url), 'utf8');
  const dialogSource = readFileSync(new URL('./QuickPortForwardDialog.tsx', import.meta.url), 'utf8');
  const combined = `${portsSource}\n${dialogSource}`;
  const keys = [...new Set([...combined.matchAll(/\bt\(['"](systemManager\.ports\.[^'"]+)['"]/g)].map((m) => m[1]))];

  assert.ok(keys.length >= 15, `expected quick-forward i18n keys, found ${keys.length}`);

  const locales = {
    en: enSystemManagerMessages,
    es: esSystemManagerMessages,
    ru: ruSystemManagerMessages,
    'zh-CN': zhCnSystemManagerMessages,
    'zh-TW': zhTwSystemManagerMessages,
  } as const;

  for (const [locale, messages] of Object.entries(locales)) {
    for (const key of keys) {
      assert.ok(messages[key]?.trim(), `${locale} missing key: ${key}`);
      if (locale !== 'en') {
        assert.notEqual(messages[key], enSystemManagerMessages[key], `${locale} left ${key} untranslated`);
      }
    }
  }

  // Ensure Taiwan Traditional Chinese uses Taiwan terminology.
  const zhTwForwardText = keys.map((key) => zhTwSystemManagerMessages[key]).join('\n');
  assert.equal(zhTwForwardText.includes('端口'), false);
  assert.equal(zhTwForwardText.includes('本地'), false);
  assert.equal(zhTwForwardText.includes('地址'), false);
});

test('PortsManagerTab wires quick port forwarding with active badge, stop action, and dialog', () => {
  const source = readFileSync(new URL('./PortsManagerTab.tsx', import.meta.url), 'utf8');
  const slotSource = readFileSync(
    new URL('../terminalLayer/terminalLayerSidePanelSlots.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /useQuickPortForwarding/);
  assert.match(source, /QuickPortForwardDialog/);
  assert.match(source, /isForwardableListeningPort/);
  assert.match(source, /matchListeningPortForwardRules/);
  assert.match(source, /handleCopyLocalEndpoint/);
  assert.match(source, /handleStopForward/);
  assert.match(slotSource, /portForwardingContext=\{portForwardingContext\}/);
});
