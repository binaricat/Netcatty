import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bashArityPrefix } from './bashArity';

describe('bashArity (OpenCode parity)', () => {
  it('unknown commands default to first token', () => {
    assert.deepEqual(bashArityPrefix(['unknown', 'command', 'subcommand']), ['unknown']);
    assert.deepEqual(bashArityPrefix(['touch', 'foo.txt']), ['touch']);
  });

  it('two token commands', () => {
    assert.deepEqual(bashArityPrefix(['git', 'checkout', 'main']), ['git', 'checkout']);
    assert.deepEqual(bashArityPrefix(['docker', 'run', 'nginx']), ['docker', 'run']);
  });

  it('three token commands', () => {
    assert.deepEqual(bashArityPrefix(['aws', 's3', 'ls', 'my-bucket']), ['aws', 's3', 'ls']);
    assert.deepEqual(bashArityPrefix(['npm', 'run', 'dev', 'script']), ['npm', 'run', 'dev']);
  });

  it('longest match wins', () => {
    assert.deepEqual(bashArityPrefix(['docker', 'compose', 'up', 'service']), ['docker', 'compose', 'up']);
    assert.deepEqual(bashArityPrefix(['consul', 'kv', 'get', 'config']), ['consul', 'kv', 'get']);
  });

  it('lscpu uses first token only', () => {
    assert.deepEqual(bashArityPrefix(['lscpu']), ['lscpu']);
  });
});
