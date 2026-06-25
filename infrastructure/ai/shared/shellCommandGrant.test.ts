import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAlwaysAllowCommandPatterns } from './shellCommandGrant';

describe('shellCommandGrant (OpenCode always patterns)', () => {
  it('builds prefix wildcard for simple commands', () => {
    assert.deepEqual(buildAlwaysAllowCommandPatterns('lscpu'), ['lscpu *']);
    assert.deepEqual(buildAlwaysAllowCommandPatterns('touch foo.txt'), ['touch *']);
  });

  it('builds subcommand-aware prefixes', () => {
    assert.deepEqual(buildAlwaysAllowCommandPatterns('git checkout main'), ['git checkout *']);
    assert.deepEqual(buildAlwaysAllowCommandPatterns('systemctl status nginx'), ['systemctl status *']);
    assert.deepEqual(buildAlwaysAllowCommandPatterns('npm run dev'), ['npm run dev *']);
  });

  it('skips cd segments in chains but keeps others', () => {
    assert.deepEqual(
      buildAlwaysAllowCommandPatterns('cd /tmp && ls -la'),
      ['ls *'],
    );
  });
});
