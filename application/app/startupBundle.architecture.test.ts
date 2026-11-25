import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Guards for what the startup bundle (index.html entry) may pull in. Each of
// these used to land in the entry chunk that every window parses at launch.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const staticImports = (source: string) =>
  [...source.matchAll(/^\s*import\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((match) => match[1]);

const STATIC_SPECIFIER_RE =
  /(?:^|\n)\s*(?:import\s+(?!type\b)(?:[^;'"]*?\s+from\s+)?|export\s+(?!type\b)[^;'"]*?\s+from\s+)['"]([^'"]+)['"]/g;
const CJS_REQUIRE_RE = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;

function extractStaticModuleSpecifiers(filePath: string, source: string): string[] {
  const specs: string[] = [];
  for (const match of source.matchAll(STATIC_SPECIFIER_RE)) {
    specs.push(match[1]);
  }
  if (filePath.endsWith('.cjs')) {
    for (const match of source.matchAll(CJS_REQUIRE_RE)) {
      specs.push(match[1]);
    }
  }
  return specs;
}

function resolveLocalModule(fromFile: string, specifier: string): string | null {
  let base: string | null = null;
  if (specifier.startsWith('@/')) {
    base = join(root, specifier.slice(2));
  } else if (specifier.startsWith('.')) {
    base = resolve(dirname(fromFile), specifier);
  }
  if (!base) return null;

  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
    join(base, 'index.js'),
    join(base, 'index.jsx'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function collectStartupExternalDependencies(entryRelativePath: string): Map<string, string[]> {
  const entryAbs = join(root, entryRelativePath);
  const visited = new Set<string>([entryAbs]);
  const parentChain = new Map<string, string[]>([[entryAbs, [entryRelativePath]]]);
  const externalPaths = new Map<string, string[]>();
  const queue: string[] = [entryAbs];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const source = readFileSync(current, 'utf8');
    const chain = parentChain.get(current)!;

    for (const specifier of extractStaticModuleSpecifiers(current, source)) {
      if (specifier.startsWith('.') || specifier.startsWith('@/')) {
        const resolved = resolveLocalModule(current, specifier);
        if (resolved && !visited.has(resolved)) {
          visited.add(resolved);
          parentChain.set(resolved, [...chain, relative(root, resolved)]);
          queue.push(resolved);
        }
        continue;
      }
      if (!externalPaths.has(specifier)) {
        externalPaths.set(specifier, [...chain, specifier]);
      }
    }
  }
  return externalPaths;
}

test('only the English dictionary is bundled with the startup entry', () => {
  const imports = staticImports(read('application/i18n/messages.ts'));
  assert.deepEqual(imports.filter((path) => path.startsWith('./locales/')), ['./locales/en']);
});

test('startup modules do not statically import the AI runtime or SDK providers', () => {
  const runtimeModules = /harness\/globalAgentRuntime|plugin\/trustedHostRuntime|plugin\/configuredModel|pluginAgent\/trustedAgentRuntime|sdk\/providers/;
  for (const path of [
    'application/state/aiStateSnapshots.ts',
    'application/state/usePluginAIContextHost.ts',
    'application/state/usePluginAgentHost.ts',
  ]) {
    const offending = staticImports(read(path)).filter((specifier) => runtimeModules.test(specifier));
    assert.deepEqual(offending, [], `${path} must load the AI runtime lazily`);
  }
});

test("Vite's preload helper stays out of the vendor-ai chunk", () => {
  // The entry imports the helper for its dynamic imports; if it is grouped
  // with the AI SDK, the whole vendor-ai chunk is preloaded at startup.
  assert.match(read('vite.config.ts'), /vite\/preload-helper'\)\) return 'preload-helper'/);
});

test('the QR decoder and RE2JS regex validator are loaded on demand', () => {
  const imports = staticImports(read('components/HostTotpFields.tsx'));
  assert.ok(!imports.includes('jsqr'));
  assert.ok(!imports.includes('re2js'));
});

test('startup entry does not statically reach re2js, css-tree, @remote-dom/core, or @monaco-editor/react', () => {
  const externals = collectStartupExternalDependencies('index.tsx');
  const forbidden = [
    { label: 're2js', match: (spec: string) => spec === 're2js' || spec.startsWith('re2js/') },
    { label: 'css-tree', match: (spec: string) => spec === 'css-tree' || spec.startsWith('css-tree/') },
    { label: '@remote-dom/core', match: (spec: string) => spec === '@remote-dom/core' || spec.startsWith('@remote-dom/core/') },
    { label: '@monaco-editor/react', match: (spec: string) => spec === '@monaco-editor/react' || spec.startsWith('@monaco-editor/react/') },
  ];

  for (const rule of forbidden) {
    const matchEntry = [...externals.entries()].find(([spec]) => rule.match(spec));
    assert.equal(
      matchEntry,
      undefined,
      `${rule.label} must not be statically reachable from index.tsx (found via ${matchEntry?.[1].join(' -> ')})`,
    );
  }
});
