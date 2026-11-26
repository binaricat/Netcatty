import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_WORKSPACE_TITLE,
  buildMergedWorkspaceTitle,
  buildMergedWorkspaceTitleFromSessions,
  getSessionConnectionLabel,
  isGenericLoopbackHostname,
  resolveCodingCliProviderIconUpdate,
  resolveSessionTabTitle,
  resolveWorkspaceTabLabel,
  shouldUpdateCodingCliTabIcon,
} from './sessionTabTitle';

test('getSessionConnectionLabel prefers customName over hostLabel', () => {
  assert.equal(
    getSessionConnectionLabel({ customName: 'Prod', hostLabel: 'web-01' }),
    'Prod',
  );
  assert.equal(
    getSessionConnectionLabel({ hostLabel: 'web-01' }),
    'web-01',
  );
});

test('resolveSessionTabTitle ignores dynamic title for non-agent sessions', () => {
  assert.equal(
    resolveSessionTabTitle(
      { hostLabel: 'web-01', dynamicTitle: 'root@v2022:/var/log' },
    ),
    'web-01',
  );
});

test('resolveSessionTabTitle uses dynamic title for agent sessions', () => {
  assert.equal(
    resolveSessionTabTitle(
      { hostLabel: 'web-01', dynamicTitle: 'claude: refactor auth', codingCliProviderId: 'claude' },
    ),
    'claude: refactor auth',
  );
});

test('resolveSessionTabTitle uses dynamic title for all sessions in all mode', () => {
  assert.equal(
    resolveSessionTabTitle(
      { hostLabel: 'web-01', dynamicTitle: 'root@v2022:/var/log' },
      'all',
    ),
    'root@v2022:/var/log',
  );
});

test('resolveSessionTabTitle disables dynamic titles in off mode', () => {
  assert.equal(
    resolveSessionTabTitle(
      { hostLabel: 'web-01', dynamicTitle: 'claude: refactor auth', codingCliProviderId: 'claude' },
      'off',
    ),
    'web-01',
  );
});

test('resolveSessionTabTitle falls back to connection label when dynamic title is empty', () => {
  assert.equal(
    resolveSessionTabTitle({ hostLabel: 'web-01', dynamicTitle: '   ' }),
    'web-01',
  );
});

test('resolveSessionTabTitle prefers user customName over dynamic title', () => {
  assert.equal(
    resolveSessionTabTitle(
      { customName: 'Prod deploy', hostLabel: 'web-01', dynamicTitle: 'claude: refactor auth' },
    ),
    'Prod deploy',
  );
});

test('resolveSessionTabTitle strips agent spinner prefixes from dynamic titles', () => {
  assert.equal(
    resolveSessionTabTitle(
      { hostLabel: 'web-01', dynamicTitle: '⠋ Droid', codingCliProviderId: 'droid' },
    ),
    'Droid',
  );
});

test('resolveSessionTabTitle uses a detected prompt host ahead of hostLabel', () => {
  assert.equal(
    resolveSessionTabTitle({
      hostLabel: 'jumpserver',
      promptHostname: '10.1.64.1',
    }),
    '10.1.64.1',
  );
});

test('resolveSessionTabTitle keeps user and agent titles ahead of prompt host', () => {
  assert.equal(
    resolveSessionTabTitle({
      customName: 'my target',
      hostLabel: 'jumpserver',
      promptHostname: '10.1.64.1',
    }),
    'my target',
  );
  assert.equal(
    resolveSessionTabTitle({
      hostLabel: 'jumpserver',
      promptHostname: '10.1.64.1',
      dynamicTitle: 'claude: deploy',
      codingCliProviderId: 'claude',
    }),
    'claude: deploy',
  );
});

test('resolveSessionTabTitle prefers the live prompt host over a generic shell title', () => {
  assert.equal(
    resolveSessionTabTitle(
      {
        hostLabel: 'jumpserver',
        promptHostname: '10.1.64.1',
        dynamicTitle: 'jie.zhao@jumpssh.riverbegin.cn:2222',
      },
      'all',
    ),
    '10.1.64.1',
  );
});

test('isGenericLoopbackHostname matches only generic localhost and loopback names', () => {
  for (const generic of [
    'localhost',
    'localhost.localdomain',
    'localhost.local',
    '127.0.0.1',
    '::1',
    'LocalHost',
    '  LOCALHOST.LOCALDOMAIN. ',
    'localhost.',
  ]) {
    assert.equal(isGenericLoopbackHostname(generic), true, generic);
  }
  for (const specific of ['', '   ', '.', 'localhost..', 'ubuntu', '10.1.64.1', '192.168.100.222']) {
    assert.equal(isGenericLoopbackHostname(specific), false, specific);
  }
});

test('resolveSessionTabTitle ignores generic localhost prompt hosts in default and agent modes', () => {
  for (const promptHostname of [
    'localhost',
    'localhost.localdomain',
    'localhost.local',
    '127.0.0.1',
    '::1',
    'LocalHost',
    'localhost.',
  ]) {
    assert.equal(
      resolveSessionTabTitle({
        hostLabel: '192.168.100.222',
        promptHostname,
      }),
      '192.168.100.222',
    );
    assert.equal(
      resolveSessionTabTitle(
        {
          hostLabel: '192.168.100.222',
          promptHostname,
          dynamicTitle: 'root@localhost:~',
        },
        'agent',
      ),
      '192.168.100.222',
    );
  }
});

test('resolveSessionTabTitle keeps distinct SSH hostLabels when both remotes report localhost', () => {
  const sessionA = { hostLabel: '192.168.100.222', promptHostname: 'localhost' };
  const sessionB = { hostLabel: '192.168.100.220', promptHostname: 'localhost' };
  assert.equal(resolveSessionTabTitle(sessionA), '192.168.100.222');
  assert.equal(resolveSessionTabTitle(sessionB), '192.168.100.220');
});

test('resolveSessionTabTitle keeps customName ahead of a generic prompt host', () => {
  assert.equal(
    resolveSessionTabTitle({
      customName: 'LAN Node 1',
      hostLabel: '192.168.100.222',
      promptHostname: 'localhost',
    }),
    'LAN Node 1',
  );
});

test('getSessionConnectionLabel skips generic promptHostname and keeps non-generic ones', () => {
  assert.equal(
    getSessionConnectionLabel({
      hostLabel: '192.168.100.222',
      promptHostname: 'localhost',
    }),
    '192.168.100.222',
  );
  assert.equal(
    getSessionConnectionLabel({
      hostLabel: '192.168.100.222',
      promptHostname: 'localhost.localdomain',
    }),
    '192.168.100.222',
  );
  assert.equal(
    getSessionConnectionLabel({
      customName: 'Node 222',
      hostLabel: '192.168.100.222',
      promptHostname: 'localhost',
    }),
    'Node 222',
  );
  assert.equal(
    getSessionConnectionLabel({
      hostLabel: '192.168.100.222',
      promptHostname: 'ubuntu',
    }),
    'ubuntu',
  );
});

test('resolveSessionTabTitle keeps non-generic prompt host overrides across default, agent, and all modes', () => {
  assert.equal(
    resolveSessionTabTitle({
      hostLabel: '192.168.100.222',
      promptHostname: 'ubuntu',
    }),
    'ubuntu',
  );
  assert.equal(
    resolveSessionTabTitle(
      {
        hostLabel: '192.168.100.222',
        promptHostname: 'ubuntu',
      },
      'agent',
    ),
    'ubuntu',
  );
  assert.equal(
    resolveSessionTabTitle(
      {
        hostLabel: '192.168.100.222',
        promptHostname: 'ubuntu',
        dynamicTitle: 'root@ubuntu:~',
      },
      'all',
    ),
    'ubuntu',
  );
});

test('coding CLI icon updates stop without clearing the current icon when dynamic titles are off', () => {
  assert.equal(shouldUpdateCodingCliTabIcon('off'), false);
  assert.equal(shouldUpdateCodingCliTabIcon('agent'), true);
  assert.equal(shouldUpdateCodingCliTabIcon('all'), true);

  assert.equal(resolveCodingCliProviderIconUpdate({
    dynamicTabTitleMode: 'off',
    currentProviderId: 'claude',
    nextProviderId: null,
  }), undefined);
  assert.equal(resolveCodingCliProviderIconUpdate({
    dynamicTabTitleMode: 'off',
    currentProviderId: 'claude',
    nextProviderId: 'opencode',
  }), undefined);
  assert.equal(resolveCodingCliProviderIconUpdate({
    dynamicTabTitleMode: 'agent',
    currentProviderId: 'claude',
    nextProviderId: null,
  }), null);
});

test('resolveWorkspaceTabLabel keeps a user-renamed workspace title', () => {
  assert.equal(
    resolveWorkspaceTabLabel(
      { title: 'My Cluster', focusedSessionId: 's1' },
      [{ id: 's1', hostLabel: 'web-01', hostId: 'host-web' }],
    ),
    'My Cluster',
  );
});

test('resolveWorkspaceTabLabel derives the focused host name from a default-title workspace', () => {
  assert.equal(
    resolveWorkspaceTabLabel(
      { title: DEFAULT_WORKSPACE_TITLE, focusedSessionId: 's2' },
      [
        { id: 's1', hostLabel: 'Localhost', hostId: 'local-terminal' },
        { id: 's2', hostLabel: 'prod-db', hostId: 'host-db' },
      ],
    ),
    // Two distinct hosts: focused host + "+1" for the other.
    'prod-db +1',
  );
});

test('resolveWorkspaceTabLabel shows a single host name without a suffix', () => {
  assert.equal(
    resolveWorkspaceTabLabel(
      { title: DEFAULT_WORKSPACE_TITLE, focusedSessionId: 's1' },
      [
        // Two local terminals share the stable local hostId.
        { id: 's1', hostLabel: 'Localhost', hostId: 'local-terminal' },
        { id: 's2', hostLabel: 'Localhost', hostId: 'local-terminal' },
      ],
    ),
    'Localhost',
  );
});

test('resolveWorkspaceTabLabel does not add a suffix when a same-host pane is renamed', () => {
  assert.equal(
    resolveWorkspaceTabLabel(
      { title: DEFAULT_WORKSPACE_TITLE, focusedSessionId: 's1' },
      [
        { id: 's1', hostLabel: 'web-01', hostId: 'host-web' },
        // Same host (hostId), but a rename rewrote this pane's customName AND
        // hostLabel — hostId still ties it to the same host, so no "+1".
        { id: 's2', customName: 'logs', hostLabel: 'logs', hostId: 'host-web' },
      ],
    ),
    'web-01',
  );
});

test('resolveWorkspaceTabLabel shows the focused rename while counting hosts', () => {
  assert.equal(
    resolveWorkspaceTabLabel(
      { title: DEFAULT_WORKSPACE_TITLE, focusedSessionId: 's1' },
      [
        { id: 's1', customName: 'my-web', hostLabel: 'my-web', hostId: 'host-web' },
        { id: 's2', hostLabel: 'db-02', hostId: 'host-db' },
      ],
    ),
    'my-web +1',
  );
});

test('resolveWorkspaceTabLabel keeps a workspace explicitly named "Workspace"', () => {
  // autoTitle:false marks the title as user-chosen even when it equals the
  // default sentinel — it must not be replaced by a host label.
  assert.equal(
    resolveWorkspaceTabLabel(
      { title: DEFAULT_WORKSPACE_TITLE, autoTitle: false, focusedSessionId: 's1' },
      [{ id: 's1', hostLabel: 'web-01', hostId: 'host-web' }],
    ),
    'Workspace',
  );
});

test('resolveWorkspaceTabLabel derives a label for an explicitly auto-titled workspace', () => {
  assert.equal(
    resolveWorkspaceTabLabel(
      { title: DEFAULT_WORKSPACE_TITLE, autoTitle: true, focusedSessionId: 's1' },
      [{ id: 's1', hostLabel: 'Localhost', hostId: 'local-terminal' }],
    ),
    'Localhost',
  );
});

test('resolveWorkspaceTabLabel falls back to the default title with no sessions', () => {
  assert.equal(
    resolveWorkspaceTabLabel({ title: DEFAULT_WORKSPACE_TITLE, focusedSessionId: null }, []),
    DEFAULT_WORKSPACE_TITLE,
  );
});

test('buildMergedWorkspaceTitle joins both tab labels with a slash', () => {
  assert.equal(buildMergedWorkspaceTitle('01', '02'), '01/02');
  assert.equal(buildMergedWorkspaceTitle('web-01', 'db-02'), 'web-01/db-02');
});

test('buildMergedWorkspaceTitle collapses identical labels to one name', () => {
  assert.equal(buildMergedWorkspaceTitle('web-01', 'web-01'), 'web-01');
});

test('buildMergedWorkspaceTitle falls back to the labeled side', () => {
  assert.equal(buildMergedWorkspaceTitle('', '02'), '02');
  assert.equal(buildMergedWorkspaceTitle('01', ''), '01');
});

test('buildMergedWorkspaceTitle returns null when neither tab has a label', () => {
  assert.equal(buildMergedWorkspaceTitle('', ''), null);
});

test('buildMergedWorkspaceTitleFromSessions recomputes from live membership', () => {
  const sessions = [
    { id: 'a', customName: '01', hostLabel: '01', hostId: 'h1' },
    { id: 'b', customName: '02', hostLabel: '02', hostId: 'h2' },
  ];
  assert.equal(buildMergedWorkspaceTitleFromSessions(sessions), '01/02');
  // After renaming pane "02" the composed title follows.
  assert.equal(
    buildMergedWorkspaceTitleFromSessions([
      sessions[0],
      { ...sessions[1], customName: 'prod', hostLabel: 'prod' },
    ]),
    '01/prod',
  );
  // After removing a pane the title collapses to the remaining label.
  assert.equal(buildMergedWorkspaceTitleFromSessions([sessions[1]]), '02');
  // Identical labels still collapse; unlabeled panes are skipped.
  assert.equal(
    buildMergedWorkspaceTitleFromSessions([
      sessions[0],
      { id: 'c', customName: '', hostLabel: '', hostId: 'h3' },
      { ...sessions[0], id: 'd' },
    ]),
    '01',
  );
  assert.equal(buildMergedWorkspaceTitleFromSessions([]), null);
  // A third pane whose label duplicates a non-adjacent member is collapsed too.
  assert.equal(
    buildMergedWorkspaceTitleFromSessions([
      sessions[0],
      sessions[1],
      { ...sessions[0], id: 'd' },
    ]),
    '01/02',
  );
});
