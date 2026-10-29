import { buildHostViewExample } from './build-plugin-view-example.mjs';
for (const name of ['hello-vault', 'hello-world-v2', 'session-scratchpad', 'vault-scratchpad', 'settings-view-fixture', 'starter-netcatty', 'assistant', 'global-agent']) {
  await buildHostViewExample(new URL(`../examples/plugins/${name}/`, import.meta.url));
}
await import('../examples/plugins/hello-react-host/build.mjs');
