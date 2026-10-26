// Test-only IPC replacement. Inject BEFORE loading the real settings renderer.
// This function is self-contained so Playwright and an isolated Electron preload
// can both serialize it. Every service mutation is synthetic and recorded.
function installAiToolAccessFixture(options = {}) {
  if (location.hostname !== '127.0.0.1' && location.hostname !== 'localhost') throw new Error('QA fixture requires a loopback origin');
  const calls = [];
  const qa = { calls, rejectPrivacy: false, rejectHttp: false, holdStatus: false, pending: [] };
  window.__aiToolQa = qa;
  localStorage.clear();
  localStorage.setItem('netcatty_ui_language_v1', options.locale || 'en');
  localStorage.setItem('netcatty_theme_v1', options.theme || 'dark');
  localStorage.setItem('netcatty_ai_external_mcp_enabled_v1', String(options.enabled ?? true));
  localStorage.setItem('netcatty_ai_external_mcp_mode_v1', 'persistent');
  let status = {
    ok: true, enabled: options.enabled ?? true, state: options.enabled === false ? 'disabled' : 'running',
    exposedSessionCount: 2, permissionMode: 'confirm',
    launcherPath: '/fixture/netcatty/launcher', discoveryPath: '/fixture/netcatty/discovery.json',
    http: { enabled: false, listening: false, port: 47391, listenAddress: '127.0.0.1', clientHost: '', url: 'http://127.0.0.1:47391/mcp', bearerToken: null },
  };
  const clients = Object.fromEntries(['Codex', 'Claude', 'Grok'].map((name) => [name, { ok: true, state: 'not_configured', launcherPath: status.launcherPath }]));
  const record = (name, fn) => async (...args) => { calls.push({ name, args }); return fn(...args); };
  const bridge = {
    getAppLockRuntimeState: async () => ({ initialized: true, locked: false, reason: null, version: 1 }),
    externalMcpGetStatus: record('status', () => qa.holdStatus ? new Promise((resolve) => qa.pending.push(() => resolve(structuredClone(status)))) : structuredClone(status)),
    externalMcpSetEnabled: record('enable', (enabled) => { status.enabled = enabled; status.state = enabled ? 'running' : 'disabled'; return structuredClone(status); }),
    externalMcpSetConfig: record('config', (config) => {
      if (config.redaction && qa.rejectPrivacy) return { ok: false, error: 'Fixture: invalid CIDR or RE2 pattern.' };
      if ('httpEnabled' in config && qa.rejectHttp) return { ...structuredClone(status), ok: false, error: 'Fixture: port unavailable.' };
      if ('httpEnabled' in config) {
        status.http = { ...status.http, enabled: config.httpEnabled, listening: config.httpEnabled && status.enabled,
          port: config.httpPort, listenAddress: config.httpAllowCustomBind ? config.httpListenAddress : '127.0.0.1',
          clientHost: config.httpClientHost, bearerToken: config.httpEnabled ? 'SYNTHETIC_FIXTURE_TOKEN_NEVER_REAL' : null };
        status.http.url = `http://${config.httpClientHost || '127.0.0.1'}:${config.httpPort}/mcp`;
      }
      if (config.rotateHttpToken) status.http.bearerToken = 'SYNTHETIC_ROTATED_FIXTURE_TOKEN';
      return structuredClone(status);
    }),
    externalMcpGetUniversalSetupPrompt: async () => ({ ok: true, prompt: 'Synthetic setup prompt: register the fixture launcher as netcatty-external.' }),
    aiSkillsCliGetInvocation: async () => ({ ok: true, skillPath: '/fixture/netcatty/skills/SKILL.md', commandPrefix: 'netcatty-tool-cli' }),
    aiUserSkillsGetStatus: async () => ({ ok: true, directoryPath: '/fixture/netcatty/skills', readyCount: 0, warningCount: 0, skills: [] }),
    aiResolveCli: async () => ({ installed: false, available: false }),
    aiCodexGetIntegrationStatus: async () => ({ ok: true, available: false }),
    aiCodexAppServerGetStatus: async () => ({ ok: true, available: false }),
  };
  for (const name of ['Codex', 'Claude', 'Grok']) {
    bridge[`externalMcp${name}GetStatus`] = record(`${name}Status`, () => structuredClone(clients[name]));
    bridge[`externalMcp${name}Add`] = record(`${name}Add`, () => { clients[name].state = 'configured'; return structuredClone(clients[name]); });
  }
  Object.defineProperty(window, 'netcatty', { value: bridge, configurable: true });
}
module.exports = { installAiToolAccessFixture };
