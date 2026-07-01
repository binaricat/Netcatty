import test from 'node:test';
import assert from 'node:assert/strict';

import { formatVaultToolTooltip } from './formatVaultToolTooltip.ts';

test('formatVaultToolTooltip joins tool name, args, and result with line breaks', () => {
  const text = formatVaultToolTooltip(
    'vault_notes_create',
    { title: 'Runbook' },
    { ok: true, note: { id: 'n1', title: 'Runbook' } },
  );

  assert.match(text, /^vault_notes_create/);
  assert.match(text, /Arguments:/);
  assert.match(text, /"title": "Runbook"/);
  assert.match(text, /Result:/);
  assert.match(text, /"ok": true/);
});
