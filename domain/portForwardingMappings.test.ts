import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Host } from './models';
import {
  createPortForwardingRule,
  duplicatePortForwardingRule,
  getRuleMappings,
  normalizeRuleMappings,
  updatePortForwardingRule,
} from './portForwardingAgentOps';

const host: Host = { id: 'host-1', label: 'Host', hostname: 'host.test', username: 'root', tags: [], os: 'linux' };
const singleSource = {
  label: 'Web', type: 'local', localPort: 8080, bindAddress: '127.0.0.1',
  remoteHost: '127.0.0.1', remotePort: 80, hostId: 'host-1',
};

describe('getRuleMappings', () => {
  it('derives the single pair from scalar fields', () => {
    const rule = { type: 'local' as const, localPort: 8080, remotePort: 80 };
    assert.deepEqual(getRuleMappings(rule), [{ localPort: 8080, remotePort: 80 }]);
  });

  it('returns stored mappings for multi-mapping rules', () => {
    const rule = {
      type: 'local' as const, localPort: 8080, remotePort: 80,
      mappings: [{ localPort: 8080, remotePort: 80 }, { localPort: 9090, remotePort: 90 }],
    };
    assert.deepEqual(getRuleMappings(rule), rule.mappings);
  });

  it('returns no mappings for dynamic rules', () => {
    assert.deepEqual(getRuleMappings({ type: 'dynamic', localPort: 1080 }), []);
  });
});

describe('normalizeRuleMappings', () => {
  it('accepts valid rows and a JSON string', () => {
    const rows = [{ localPort: 8080, remotePort: 80 }, { localPort: 9090, remotePort: 90 }];
    assert.deepEqual(normalizeRuleMappings('local', rows), { ok: true, value: rows });
    assert.deepEqual(
      normalizeRuleMappings('local', JSON.stringify(rows)),
      { ok: true, value: rows },
    );
  });

  it('rejects duplicate local ports, invalid ports, and dynamic rules', () => {
    const duplicate = normalizeRuleMappings('local', [
      { localPort: 8080, remotePort: 80 }, { localPort: 8080, remotePort: 90 },
    ]);
    assert.equal(duplicate.ok, false);
    if (!duplicate.ok) assert.match(duplicate.error, /Duplicate local port 8080/);
    assert.equal(normalizeRuleMappings('local', [{ localPort: 0, remotePort: 80 }]).ok, false);
    assert.equal(normalizeRuleMappings('local', [{ localPort: 8080 }]).ok, false);
    assert.equal(normalizeRuleMappings('dynamic', [{ localPort: 1080, remotePort: 80 }]).ok, false);
    assert.equal(normalizeRuleMappings('local', 'not json').ok, false);
    assert.equal(normalizeRuleMappings('local', {}).ok, false);
  });

  it('treats undefined and empty array as no mappings', () => {
    assert.deepEqual(normalizeRuleMappings('local', undefined), { ok: true, value: [] });
    assert.deepEqual(normalizeRuleMappings('local', []), { ok: true, value: [] });
  });
});

describe('multi-mapping rules through agent ops', () => {
  it('stores mappings only when more than one row and mirrors the first into scalars', () => {
    const multi = createPortForwardingRule([], [host], {
      ...singleSource,
      mappings: [
        { localPort: 8080, remotePort: 80 },
        { localPort: 9090, remotePort: 90 },
      ],
    }, { id: 'rule-multi', now: 1 });
    assert.equal(multi.ok, true);
    if (multi.ok) {
      assert.deepEqual(multi.value.rule.mappings, [
        { localPort: 8080, remotePort: 80 },
        { localPort: 9090, remotePort: 90 },
      ]);
      assert.equal(multi.value.rule.localPort, 8080);
      assert.equal(multi.value.rule.remotePort, 80);
    }

    const single = createPortForwardingRule([], [host], {
      ...singleSource,
      mappings: [{ localPort: 8080, remotePort: 80 }],
    }, { id: 'rule-single', now: 2 });
    assert.equal(single.ok, true);
    if (single.ok) assert.equal(single.value.rule.mappings, undefined);
  });

  it('resets status when mappings change but keeps it on relabel', () => {
    const created = createPortForwardingRule([], [host], {
      ...singleSource,
      mappings: [{ localPort: 8080, remotePort: 80 }, { localPort: 9090, remotePort: 90 }],
    }, { id: 'rule-1', now: 1 });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const active = { ...created.value.rule, status: 'active' as const, error: 'x' };

    const added = updatePortForwardingRule([active], [host], 'rule-1', {
      mappings: [
        { localPort: 8080, remotePort: 80 },
        { localPort: 9090, remotePort: 90 },
        { localPort: 7070, remotePort: 70 },
      ],
    });
    assert.equal(added.ok, true);
    if (added.ok) {
      assert.equal(added.value.rule.status, 'inactive');
      assert.equal(added.value.rule.error, undefined);
    }

    const relabeled = updatePortForwardingRule([active], [host], 'rule-1', { label: 'Renamed' });
    assert.equal(relabeled.ok, true);
    if (relabeled.ok) assert.equal(relabeled.value.rule.status, 'active');

    const stripped = updatePortForwardingRule([active], [host], 'rule-1', { mappings: [] });
    assert.equal(stripped.ok, true);
    if (stripped.ok) {
      assert.equal(stripped.value.rule.mappings, undefined);
      assert.equal(stripped.value.rule.localPort, 8080);
      assert.equal(stripped.value.rule.status, 'inactive');
    }
  });

  it('duplicates multi-mapping rules with mappings intact', () => {
    const created = createPortForwardingRule([], [host], {
      ...singleSource,
      mappings: [{ localPort: 8080, remotePort: 80 }, { localPort: 9090, remotePort: 90 }],
    }, { id: 'rule-1', now: 1 });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const duplicated = duplicatePortForwardingRule(
      [created.value.rule], [host], 'rule-1', { id: 'rule-2', now: 2 },
    );
    assert.equal(duplicated.ok, true);
    if (duplicated.ok) {
      assert.deepEqual(duplicated.value.rule.mappings, created.value.rule.mappings);
      assert.equal(duplicated.value.rule.localPort, 8080);
    }
  });
});
