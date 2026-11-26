import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_WORKSPACE_TITLE,
  buildMergedWorkspaceTitle,
  buildMergedWorkspaceTitleFromSessions,
  getSessionConnectionLabel,
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

test('connection identity ignores live prompt hostnames', () => {
  const session = { hostLabel: 'Production', promptHostname: 'vm-prod' };
  assert.equal(getSessionConnectionLabel(session), session.hostLabel);
});

test('ordinary SSH prompt hostnames do not replace configured names by default', () => {
  const session = { hostLabel: 'Production', promptHostname: 'vm-prod' };
  for (const mode of [undefined, 'off', 'agent'] as const) {
    assert.equal(resolveSessionTabTitle(session, mode), session.hostLabel, String(mode));
  }
});

test('agent mode does not use a prompt hostname when the agent has no title', () => {
  const session = {
    hostLabel: 'Production', promptHostname: 'vm-prod', codingCliProviderId: 'claude' as const,
  };
  assert.equal(resolveSessionTabTitle(session, 'agent'), session.hostLabel);
});

test('persisted merged workspace identities ignore live hostnames', () => {
  const sessions = [
    { id: 'a', hostId: 'h1', hostLabel: 'Production', promptHostname: 'vm-prod' },
    { id: 'b', hostId: 'h2', hostLabel: 'Database', promptHostname: 'db-prod' },
  ];
  assert.equal(
    buildMergedWorkspaceTitleFromSessions(sessions),
    buildMergedWorkspaceTitle(sessions[0].hostLabel, sessions[1].hostLabel),
  );
});

test('auto workspace labels honor disabled and agent-only modes', () => {
  const session = { id: 'a', hostId: 'h1', hostLabel: 'Production', promptHostname: 'vm-prod' };
  const workspace = { title: DEFAULT_WORKSPACE_TITLE, autoTitle: true, focusedSessionId: session.id };
  for (const mode of [undefined, 'off', 'agent'] as const) {
    assert.equal(resolveWorkspaceTabLabel(workspace, [session], mode), session.hostLabel, String(mode));
  }
});

test('auto workspace labels use the same agent title policy as session tabs', () => {
  const session = {
    id: 'a', hostId: 'h1', hostLabel: 'Production', promptHostname: 'vm-prod',
    dynamicTitle: 'claude: deploy', codingCliProviderId: 'claude' as const,
  };
  const workspace = { title: DEFAULT_WORKSPACE_TITLE, autoTitle: true, focusedSessionId: session.id };
  assert.equal(resolveWorkspaceTabLabel(workspace, [session], 'agent'), session.dynamicTitle);
});

test('generated workspace display titles honor mode without changing their saved identity', () => {
  const sessions = [
    { id: 'a', hostId: 'h1', hostLabel: 'Production', promptHostname: 'vm-prod' },
    { id: 'b', hostId: 'h2', hostLabel: 'Database', promptHostname: 'db-prod' },
  ];
  const savedTitle = buildMergedWorkspaceTitle(sessions[0].hostLabel, sessions[1].hostLabel)!;
  const workspace = { title: savedTitle, autoTitle: false, generatedTitle: true, focusedSessionId: 'a' };
  assert.equal(resolveWorkspaceTabLabel(workspace, sessions, 'off'), savedTitle);
  assert.equal(
    resolveWorkspaceTabLabel(workspace, sessions, 'all'),
    buildMergedWorkspaceTitle(sessions[0].promptHostname, sessions[1].promptHostname),
  );
  assert.equal(workspace.title, savedTitle);
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

test('resolveSessionTabTitle uses a detected prompt host in all mode', () => {
  assert.equal(
    resolveSessionTabTitle({
      hostLabel: 'jumpserver',
      promptHostname: '10.1.64.1',
    }, 'all'),
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

// External review examples: the expected field is part of the contract, not
// computed by resolveSessionTabTitle or another display-title helper.
const reviewedAllTitleCases = [
  {
    name: 'same-host shell title retains username and cwd',
    session: { hostLabel: 'Production', promptHostname: 'web01', dynamicTitle: 'ubuntu@web01: ~/app' },
    expectedField: 'dynamicTitle',
  },
  {
    name: 'old shell host gives way to the current prompt host',
    session: { hostLabel: 'Database entry', promptHostname: 'db02', dynamicTitle: 'ubuntu@web01: ~/app' },
    expectedField: 'promptHostname',
  },
  {
    name: 'JumpServer transport title gives way to the target prompt host',
    session: { hostLabel: 'Jump fleet', promptHostname: 'target-01', dynamicTitle: 'user@jumpssh:2222' },
    expectedField: 'promptHostname',
  },
  {
    name: 'program title retains its document context',
    session: { hostLabel: 'Editor server', promptHostname: 'web01', dynamicTitle: 'vim README.md' },
    expectedField: 'dynamicTitle',
  },
] as const;

for (const { name, session, expectedField } of reviewedAllTitleCases) {
  test(`all title policy review: ${name}`, () => {
    assert.equal(resolveSessionTabTitle(session, 'all'), session[expectedField]);
  });
}

test('all title policy compares shell hostnames case-insensitively without rewriting the title', () => {
  const session = { hostLabel: 'Production', promptHostname: 'web01', dynamicTitle: 'ubuntu@WEB01: ~/app' };
  assert.equal(resolveSessionTabTitle(session, 'all'), session.dynamicTitle);
});

test('all title policy ignores one FQDN trailing dot only when comparing host identity', () => {
  for (const session of [
    { hostLabel: 'Production', promptHostname: 'WEB01.EXAMPLE.TEST', dynamicTitle: 'ubuntu@web01.example.test.: ~/app' },
    { hostLabel: 'Production', promptHostname: 'web01.example.test.', dynamicTitle: 'ubuntu@WEB01.EXAMPLE.TEST: /srv' },
  ]) {
    assert.equal(resolveSessionTabTitle(session, 'all'), session.dynamicTitle);
  }
});

test('all title policy equates bracketed IPv6 title hosts with the same literal prompt address', () => {
  const session = {
    hostLabel: 'IPv6 production', promptHostname: '2001:DB8::A', dynamicTitle: 'root@[2001:db8::a]: ~/app',
  };
  assert.equal(resolveSessionTabTitle(session, 'all'), session.dynamicTitle);
});

test('all title policy rejects a clearly different bracketed IPv6 title host', () => {
  const session = {
    hostLabel: 'IPv6 production', promptHostname: '2001:db8::b', dynamicTitle: 'root@[2001:db8::a]: /srv',
  };
  assert.equal(resolveSessionTabTitle(session, 'all'), session.promptHostname);
});

test('all title policy does not treat embedded email or URI text as a shell host report', () => {
  for (const dynamicTitle of [
    'vim maintainer@old.example.test:notes.txt',
    'Issue for maintainer@old.example.test',
    'https://maintainer@old.example.test/docs',
    'mailto:maintainer@old.example.test',
  ]) {
    const session = { hostLabel: 'Production', promptHostname: 'web01', dynamicTitle };
    assert.equal(resolveSessionTabTitle(session, 'all'), session.dynamicTitle);
  }
});

test('reviewed shell and program titles remain disabled in default off and agent modes', () => {
  for (const { session } of reviewedAllTitleCases) {
    for (const mode of [undefined, 'off', 'agent'] as const) {
      assert.equal(resolveSessionTabTitle(session, mode), session.hostLabel);
    }
  }
});

test('manual names stay authoritative for every reviewed title and mode', () => {
  for (const example of reviewedAllTitleCases) {
    const session = { ...example.session, customName: 'Operator production tab' };
    for (const mode of [undefined, 'off', 'agent', 'all'] as const) {
      assert.equal(resolveSessionTabTitle(session, mode), session.customName);
    }
  }
});

test('active Agent titles retain priority over reviewed prompt identities only in enabled modes', () => {
  for (const example of reviewedAllTitleCases) {
    const session = { ...example.session, codingCliProviderId: 'claude' as const, dynamicTitle: 'claude: deploy' };
    for (const mode of [undefined, 'agent', 'all'] as const) {
      assert.equal(resolveSessionTabTitle(session, mode), session.dynamicTitle);
    }
    assert.equal(resolveSessionTabTitle(session, 'off'), session.hostLabel);
  }
});

const reviewedWorkspaceSessions = reviewedAllTitleCases.map(({ session }, index) => ({
  ...session, id: `review-pane-${index}`, hostId: `review-host-${index}`,
}));
const reviewedWorkspaceLabels = reviewedAllTitleCases.map(({ session, expectedField }) => session[expectedField]);

test('auto workspace titles apply the reviewed all policy to the focused pane', () => {
  for (let index = 0; index < reviewedWorkspaceSessions.length; index += 1) {
    const session = reviewedWorkspaceSessions[index];
    const workspace = { title: DEFAULT_WORKSPACE_TITLE, autoTitle: true, focusedSessionId: session.id };
    assert.equal(
      resolveWorkspaceTabLabel(workspace, reviewedWorkspaceSessions, 'all'),
      `${reviewedWorkspaceLabels[index]} +${reviewedWorkspaceSessions.length - 1}`,
    );
    for (const mode of [undefined, 'off', 'agent'] as const) {
      assert.equal(
        resolveWorkspaceTabLabel(workspace, reviewedWorkspaceSessions, mode),
        `${session.hostLabel} +${reviewedWorkspaceSessions.length - 1}`,
      );
    }
  }
});

test('generated workspace display titles apply the reviewed policy without changing stored names', () => {
  const workspace = {
    title: reviewedWorkspaceSessions.map(session => session.hostLabel).join('/'),
    autoTitle: false, generatedTitle: true, focusedSessionId: reviewedWorkspaceSessions[0].id,
  };
  const storedTitle = workspace.title;
  assert.equal(
    resolveWorkspaceTabLabel(workspace, reviewedWorkspaceSessions, 'all'),
    reviewedWorkspaceLabels.join('/'),
  );
  for (const mode of [undefined, 'off', 'agent'] as const) {
    assert.equal(resolveWorkspaceTabLabel(workspace, reviewedWorkspaceSessions, mode), storedTitle);
  }
  assert.equal(workspace.title, storedTitle);
});

test('all title policy preserves bare emails and suffixes without shell or port evidence', () => {
  for (const dynamicTitle of [
    'maintainer@old.example.test',
    'ubuntu@old.example.test: notes.txt',
    'ubuntu@old.example.test:0',
    'ubuntu@old.example.test:65536',
    'ubuntu@old.example.test:999999',
    'ubuntu@old.example.test:22garbage',
  ]) {
    const session = { hostLabel: 'Production', promptHostname: 'web01', dynamicTitle };
    assert.equal(resolveSessionTabTitle(session, 'all'), session.dynamicTitle);
  }
});

test('all title policy recognizes legal endpoint port boundaries', () => {
  for (const port of [1, 65_535]) {
    const session = { hostLabel: 'Jump fleet', promptHostname: 'target', dynamicTitle: `ubuntu@jump:${port}` };
    assert.equal(resolveSessionTabTitle(session, 'all'), session.promptHostname);
  }
});

test('all title policy does not infer short names or matching first labels as aliases', () => {
  for (const reportedHost of ['web', 'web.dev.example']) {
    const session = {
      hostLabel: 'Production', promptHostname: 'web.prod.example', dynamicTitle: `root@${reportedHost}: /srv`,
    };
    assert.equal(resolveSessionTabTitle(session, 'all'), session.promptHostname);
  }
});

test('all title policy preserves titles with invalid bracketed host addresses', () => {
  for (const reportedHost of ['not-ip', '2001:db8:::1']) {
    const session = { hostLabel: 'Production', promptHostname: 'web01', dynamicTitle: `root@[${reportedHost}]: ~/app` };
    assert.equal(resolveSessionTabTitle(session, 'all'), session.dynamicTitle);
  }
});

test('explicit workspace names ignore all reviewed live title shapes', () => {
  const workspace = { title: 'Operator layout', autoTitle: false, generatedTitle: false };
  for (const mode of [undefined, 'off', 'agent', 'all'] as const) {
    assert.equal(resolveWorkspaceTabLabel(workspace, reviewedWorkspaceSessions, mode), workspace.title);
  }
});
