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

  it('keeps cwd segments that execute shell substitutions grantable', () => {
    assert.deepEqual(
      buildAlwaysAllowCommandPatterns('cd "$(pwd)"; ls -la'),
      ['cd *', 'ls *'],
    );
  });

  it('splits single ampersand background commands', () => {
    assert.deepEqual(
      buildAlwaysAllowCommandPatterns('cd /tmp; sleep 1 & rm -rf demo'),
      ['sleep *', 'rm *'],
    );
  });

  it('ignores comments when building grants for multiline commands', () => {
    const command = [
      '# 1a) clear the kernel_options_post profile field',
      'cobbler profile edit --name=openEuler-22.03-aarch64 --kernel-options-post=""',
      '',
      '# verify',
      "cobbler profile report --name=openEuler-22.03-aarch64 | grep -i 'kernel.options'",
    ].join('\n');

    assert.deepEqual(buildAlwaysAllowCommandPatterns(command), ['cobbler *', 'grep *']);
  });

  it('does not build grants from here-doc body lines', () => {
    const command = [
      "cat <<'EOF'",
      'rm -rf /tmp/demo',
      'EOF',
    ].join('\n');

    assert.deepEqual(buildAlwaysAllowCommandPatterns(command), ['cat *']);
  });

  it('does not build grants from piped here-doc body lines', () => {
    const command = [
      'cat <<EOF | grep needle',
      'rm -rf /tmp/demo',
      'EOF',
    ].join('\n');

    assert.deepEqual(buildAlwaysAllowCommandPatterns(command), ['cat *', 'grep *']);
  });

  it('does not build grants from fd-prefixed here-doc body lines', () => {
    assert.deepEqual(
      buildAlwaysAllowCommandPatterns([
        'cat 0<<EOF',
        'rm -rf /tmp/demo',
        'EOF',
      ].join('\n')),
      ['cat *'],
    );

    assert.deepEqual(
      buildAlwaysAllowCommandPatterns([
        'cat 3<<-EOF | grep needle',
        '\trm -rf /tmp/demo',
        '\tEOF',
      ].join('\n')),
      ['cat *', 'grep *'],
    );
  });

  it('does not treat quoted here-doc operator text as a here-doc', () => {
    assert.deepEqual(
      buildAlwaysAllowCommandPatterns([
        "cd /tmp; echo '<<EOF'",
        'rm -rf demo',
        'EOF',
      ].join('\n')),
      ['echo *', 'rm *', 'EOF *'],
    );
  });

  it('resumes parsing after mixed-quoted here-doc delimiters', () => {
    assert.deepEqual(
      buildAlwaysAllowCommandPatterns([
        'cat <<E"OF"',
        'body text',
        'EOF',
        'ls -la',
      ].join('\n')),
      ['cat *', 'ls *'],
    );
  });

  it('resumes parsing after dollar-quoted here-doc delimiters', () => {
    assert.deepEqual(
      buildAlwaysAllowCommandPatterns([
        "cat <<$'EOF'",
        'body text',
        'EOF',
        'rm -rf demo',
      ].join('\n')),
      ['cat *', 'rm *'],
    );
  });

  it('resumes parsing after ANSI-C quoted here-doc delimiters', () => {
    assert.deepEqual(
      buildAlwaysAllowCommandPatterns([
        "cat <<$'E\\x4fF'",
        'body text',
        'EOF',
        'rm -rf demo',
      ].join('\n')),
      ['cat *', 'rm *'],
    );
  });

  it('does not treat arithmetic shifts as here-doc delimiters', () => {
    assert.deepEqual(
      buildAlwaysAllowCommandPatterns([
        'ls $((1 << 2))',
        'rm -rf demo',
      ].join('\n')),
      ['ls *', 'rm *'],
    );
  });
});
