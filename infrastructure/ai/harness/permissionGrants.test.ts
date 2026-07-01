import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGrantFromApproval,
  buildGrantsFromApproval,
  listGrantableCapabilityIds,
  matchPermissionGrant,
  patternMatches,
  type PermissionGrantRule,
} from './permissionGrants';

const baseRule = (overrides: Partial<PermissionGrantRule>): PermissionGrantRule => ({
  id: 'grant-1',
  capabilityId: 'terminal.execute',
  sessionPattern: 'session-a',
  createdAt: Date.now(),
  ...overrides,
});

describe('permissionGrants', () => {
  it('matches wildcard session and command patterns', () => {
    const rules = [baseRule({ sessionPattern: '*', commandPattern: 'ls *' })];
    const matched = matchPermissionGrant(rules, {
      capabilityId: 'terminal.execute',
      sessionId: 'any-session',
      args: { command: 'ls -la /tmp' },
    });
    assert.ok(matched);
  });

  it('ignores sessionPattern and matches globally by capability and command', () => {
    const rules = [baseRule({ sessionPattern: 'old-session-uuid', commandPattern: 'ls *' })];
    const matched = matchPermissionGrant(rules, {
      capabilityId: 'terminal.execute',
      sessionId: 'different-session',
      args: { command: 'ls -la /tmp' },
    });
    assert.ok(matched);
  });

  it('does not match a different capability', () => {
    const rules = [baseRule({ sessionPattern: '*' })];
    const matched = matchPermissionGrant(rules, {
      capabilityId: 'terminal.start',
      sessionId: 'session-a',
      args: { command: 'make' },
    });
    assert.equal(matched, null);
  });

  it('buildGrantFromApproval uses global scope and OpenCode-style command prefix patterns', () => {
    const grant = buildGrantFromApproval('terminal.execute', {
      sessionId: 'ssh-1',
      command: 'systemctl status nginx',
    }, 'chat-1');
    assert.ok(grant);
    assert.equal(grant.sessionPattern, '*');
    assert.equal(grant.commandPattern, 'systemctl status *');
  });

  it('buildGrantFromApproval returns null when no command grant is produced', () => {
    const grant = buildGrantFromApproval('terminal.execute', {
      sessionId: 'ssh-1',
      command: 'cd /tmp',
    }, 'chat-1');

    assert.equal(grant, null);
  });

  it('buildGrantsFromApproval emits one rule per chained command segment', () => {
    const grants = buildGrantsFromApproval('terminal.execute', {
      sessionId: 'ssh-1',
      command: 'cd /tmp && lscpu',
    }, 'chat-1');
    assert.equal(grants.length, 1);
    assert.equal(grants[0]?.commandPattern, 'lscpu *');
  });

  it('does not let a comment grant approve a multiline command', () => {
    const rules = [baseRule({ sessionPattern: '*', commandPattern: '# *' })];
    const matched = matchPermissionGrant(rules, {
      capabilityId: 'terminal.execute',
      sessionId: 'session-a',
      args: {
        command: [
          '# 1a) clear the kernel_options_post profile field',
          'cobbler profile edit --name=openEuler-22.03-aarch64 --kernel-options-post=""',
        ].join('\n'),
      },
    });

    assert.equal(matched, null);
  });

  it('requires every grantable command segment to be covered', () => {
    const rules = [
      baseRule({ id: 'grant-lscpu', sessionPattern: '*', commandPattern: 'lscpu *' }),
      baseRule({ id: 'grant-grep', sessionPattern: '*', commandPattern: 'grep *' }),
    ];
    const matched = matchPermissionGrant(rules, {
      capabilityId: 'terminal.execute',
      sessionId: 'session-a',
      args: { command: 'cd /tmp && lscpu | grep CPU' },
    });

    assert.ok(matched);

    const missingPipeSegment = matchPermissionGrant([rules[0]!], {
      capabilityId: 'terminal.execute',
      sessionId: 'session-a',
      args: { command: 'cd /tmp && lscpu | grep CPU' },
    });

    assert.equal(missingPipeSegment, null);
  });

  it('requires every background command segment to be covered', () => {
    const command = 'cd /tmp; sleep 1 & rm -rf demo';

    const matchedBySleepOnly = matchPermissionGrant([
      baseRule({ id: 'grant-sleep', sessionPattern: '*', commandPattern: 'sleep *' }),
    ], {
      capabilityId: 'terminal.execute',
      sessionId: 'session-a',
      args: { command },
    });

    assert.equal(matchedBySleepOnly, null);

    const matchedByBoth = matchPermissionGrant([
      baseRule({ id: 'grant-sleep', sessionPattern: '*', commandPattern: 'sleep *' }),
      baseRule({ id: 'grant-rm', sessionPattern: '*', commandPattern: 'rm *' }),
    ], {
      capabilityId: 'terminal.execute',
      sessionId: 'session-a',
      args: { command },
    });

    assert.ok(matchedByBoth);
  });

  it('requires cwd segments with shell substitutions to be covered', () => {
    const command = 'cd "$(pwd)"; ls -la';

    const matchedByLsOnly = matchPermissionGrant([
      baseRule({ id: 'grant-ls', sessionPattern: '*', commandPattern: 'ls *' }),
    ], {
      capabilityId: 'terminal.execute',
      sessionId: 'session-a',
      args: { command },
    });

    assert.equal(matchedByLsOnly, null);

    const matchedByBoth = matchPermissionGrant([
      baseRule({ id: 'grant-cd', sessionPattern: '*', commandPattern: 'cd *' }),
      baseRule({ id: 'grant-ls', sessionPattern: '*', commandPattern: 'ls *' }),
    ], {
      capabilityId: 'terminal.execute',
      sessionId: 'session-a',
      args: { command },
    });

    assert.ok(matchedByBoth);
  });

  it('does not let a here-doc body grant approve the wrapping command', () => {
    const command = [
      "cat <<'EOF'",
      'rm -rf /tmp/demo',
      'EOF',
    ].join('\n');

    const matchedByBody = matchPermissionGrant([
      baseRule({ id: 'grant-rm', sessionPattern: '*', commandPattern: 'rm *' }),
    ], {
      capabilityId: 'terminal.execute',
      sessionId: 'session-a',
      args: { command },
    });

    assert.equal(matchedByBody, null);

    const matchedByWrapper = matchPermissionGrant([
      baseRule({ id: 'grant-cat', sessionPattern: '*', commandPattern: 'cat *' }),
    ], {
      capabilityId: 'terminal.execute',
      sessionId: 'session-a',
      args: { command },
    });

    assert.ok(matchedByWrapper);
  });

  it('does not let a piped here-doc body grant approve the command', () => {
    const command = [
      'cat <<EOF | grep needle',
      'rm -rf /tmp/demo',
      'EOF',
    ].join('\n');

    const matchedByBody = matchPermissionGrant([
      baseRule({ id: 'grant-rm', sessionPattern: '*', commandPattern: 'rm *' }),
    ], {
      capabilityId: 'terminal.execute',
      sessionId: 'session-a',
      args: { command },
    });

    assert.equal(matchedByBody, null);

    const matchedByPipeline = matchPermissionGrant([
      baseRule({ id: 'grant-cat', sessionPattern: '*', commandPattern: 'cat *' }),
      baseRule({ id: 'grant-grep', sessionPattern: '*', commandPattern: 'grep *' }),
    ], {
      capabilityId: 'terminal.execute',
      sessionId: 'session-a',
      args: { command },
    });

    assert.ok(matchedByPipeline);
  });

  it('does not let an fd-prefixed here-doc body grant approve the command', () => {
    const command = [
      'cat 0<<EOF',
      'rm -rf /tmp/demo',
      'EOF',
    ].join('\n');

    const matchedByBody = matchPermissionGrant([
      baseRule({ id: 'grant-rm', sessionPattern: '*', commandPattern: 'rm *' }),
    ], {
      capabilityId: 'terminal.execute',
      sessionId: 'session-a',
      args: { command },
    });

    assert.equal(matchedByBody, null);

    const matchedByWrapper = matchPermissionGrant([
      baseRule({ id: 'grant-cat', sessionPattern: '*', commandPattern: 'cat *' }),
    ], {
      capabilityId: 'terminal.execute',
      sessionId: 'session-a',
      args: { command },
    });

    assert.ok(matchedByWrapper);
  });

  it('does not let quoted here-doc operator text hide later commands', () => {
    const command = [
      "cd /tmp; echo '<<EOF'",
      'rm -rf demo',
      'EOF',
    ].join('\n');

    const matchedByEchoOnly = matchPermissionGrant([
      baseRule({ id: 'grant-echo', sessionPattern: '*', commandPattern: 'echo *' }),
    ], {
      capabilityId: 'terminal.execute',
      sessionId: 'session-a',
      args: { command },
    });

    assert.equal(matchedByEchoOnly, null);

    const matchedByAll = matchPermissionGrant([
      baseRule({ id: 'grant-echo', sessionPattern: '*', commandPattern: 'echo *' }),
      baseRule({ id: 'grant-rm', sessionPattern: '*', commandPattern: 'rm *' }),
      baseRule({ id: 'grant-eof', sessionPattern: '*', commandPattern: 'EOF *' }),
    ], {
      capabilityId: 'terminal.execute',
      sessionId: 'session-a',
      args: { command },
    });

    assert.ok(matchedByAll);
  });

  it('keeps commands after mixed-quoted here-doc delimiters grantable', () => {
    const command = [
      'cat <<E"OF"',
      'body text',
      'EOF',
      'ls -la',
    ].join('\n');

    const matchedByCatOnly = matchPermissionGrant([
      baseRule({ id: 'grant-cat', sessionPattern: '*', commandPattern: 'cat *' }),
    ], {
      capabilityId: 'terminal.execute',
      sessionId: 'session-a',
      args: { command },
    });

    assert.equal(matchedByCatOnly, null);

    const matchedByBoth = matchPermissionGrant([
      baseRule({ id: 'grant-cat', sessionPattern: '*', commandPattern: 'cat *' }),
      baseRule({ id: 'grant-ls', sessionPattern: '*', commandPattern: 'ls *' }),
    ], {
      capabilityId: 'terminal.execute',
      sessionId: 'session-a',
      args: { command },
    });

    assert.ok(matchedByBoth);
  });

  it('keeps commands after dollar-quoted here-doc delimiters grantable', () => {
    const command = [
      "cat <<$'EOF'",
      'body text',
      'EOF',
      'rm -rf demo',
    ].join('\n');

    const matchedByCatOnly = matchPermissionGrant([
      baseRule({ id: 'grant-cat', sessionPattern: '*', commandPattern: 'cat *' }),
    ], {
      capabilityId: 'terminal.execute',
      sessionId: 'session-a',
      args: { command },
    });

    assert.equal(matchedByCatOnly, null);

    const matchedByBoth = matchPermissionGrant([
      baseRule({ id: 'grant-cat', sessionPattern: '*', commandPattern: 'cat *' }),
      baseRule({ id: 'grant-rm', sessionPattern: '*', commandPattern: 'rm *' }),
    ], {
      capabilityId: 'terminal.execute',
      sessionId: 'session-a',
      args: { command },
    });

    assert.ok(matchedByBoth);
  });

  it('keeps commands after ANSI-C quoted here-doc delimiters grantable', () => {
    const command = [
      "cat <<$'E\\x4fF'",
      'body text',
      'EOF',
      'rm -rf demo',
    ].join('\n');

    const matchedByCatOnly = matchPermissionGrant([
      baseRule({ id: 'grant-cat', sessionPattern: '*', commandPattern: 'cat *' }),
    ], {
      capabilityId: 'terminal.execute',
      sessionId: 'session-a',
      args: { command },
    });

    assert.equal(matchedByCatOnly, null);

    const matchedByBoth = matchPermissionGrant([
      baseRule({ id: 'grant-cat', sessionPattern: '*', commandPattern: 'cat *' }),
      baseRule({ id: 'grant-rm', sessionPattern: '*', commandPattern: 'rm *' }),
    ], {
      capabilityId: 'terminal.execute',
      sessionId: 'session-a',
      args: { command },
    });

    assert.ok(matchedByBoth);
  });

  it('does not let arithmetic shifts hide following commands', () => {
    const command = [
      'ls $((1 << 2))',
      'rm -rf demo',
    ].join('\n');

    const matchedByLsOnly = matchPermissionGrant([
      baseRule({ id: 'grant-ls', sessionPattern: '*', commandPattern: 'ls *' }),
    ], {
      capabilityId: 'terminal.execute',
      sessionId: 'session-a',
      args: { command },
    });

    assert.equal(matchedByLsOnly, null);

    const matchedByBoth = matchPermissionGrant([
      baseRule({ id: 'grant-ls', sessionPattern: '*', commandPattern: 'ls *' }),
      baseRule({ id: 'grant-rm', sessionPattern: '*', commandPattern: 'rm *' }),
    ], {
      capabilityId: 'terminal.execute',
      sessionId: 'session-a',
      args: { command },
    });

    assert.ok(matchedByBoth);
  });

  it('OpenCode wildcard allows optional args after prefix', () => {
    assert.equal(patternMatches('lscpu *', 'lscpu'), true);
    assert.equal(patternMatches('lscpu *', 'lscpu -e'), true);
    assert.equal(patternMatches('git checkout *', 'git checkout main'), true);
    assert.equal(patternMatches('git checkout *', 'git commit'), false);
  });

  it('lists grantable capability ids from catalog policy', () => {
    const ids = listGrantableCapabilityIds();
    assert.ok(ids.includes('terminal.execute'));
    assert.ok(ids.includes('sftp.write'));
    assert.ok(!ids.includes('terminal.poll'));
  });

  it('patternMatches supports regex literals', () => {
    assert.equal(patternMatches('/^ls\\b/', 'ls -la'), true);
    assert.equal(patternMatches('/^ls\\b/', 'cat file'), false);
  });
});
