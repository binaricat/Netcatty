import type { CodeHighlighterPlugin, HighlightOptions } from 'streamdown';
import type { LanguageInput, ThemeRegistrationAny } from 'shiki/core';
import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

import { createSafeCodeHighlighter } from './streamdownCodeHighlighter';

type BundledLanguage = HighlightOptions['language'];
type PluginThemeInput = HighlightOptions['themes'][number];
type HighlightResult = NonNullable<ReturnType<CodeHighlighterPlugin['highlight']>>;
type ThemeModuleLoader = () => Promise<{ default: ThemeRegistrationAny } | ThemeRegistrationAny>;

const DEFAULT_THEMES: [PluginThemeInput, PluginThemeInput] = ['github-light', 'github-dark'];
const MAX_TOKENS_CACHE_ENTRIES = 256;

const THEME_LOADERS: Record<string, ThemeModuleLoader> = {
  'github-light': () => import('shiki/themes/github-light.mjs'),
  'github-dark': () => import('shiki/themes/github-dark.mjs'),
};

/**
 * Curated SSH, DevOps, sysadmin, configuration, and programming languages.
 * Unlisted languages fall back cleanly to plain tokens via createSafeCodeHighlighter.
 */
const LANGUAGE_LOADERS: Record<string, LanguageInput> = {
  apache: () => import('shiki/langs/apache.mjs'),
  asm: () => import('shiki/langs/asm.mjs'),
  awk: () => import('shiki/langs/awk.mjs'),
  bat: () => import('shiki/langs/bat.mjs'),
  bicep: () => import('shiki/langs/bicep.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cmake: () => import('shiki/langs/cmake.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  csv: () => import('shiki/langs/csv.mjs'),
  cue: () => import('shiki/langs/cue.mjs'),
  dart: () => import('shiki/langs/dart.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  docker: () => import('shiki/langs/docker.mjs'),
  dotenv: () => import('shiki/langs/dotenv.mjs'),
  elixir: () => import('shiki/langs/elixir.mjs'),
  fish: () => import('shiki/langs/fish.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  groovy: () => import('shiki/langs/groovy.mjs'),
  haskell: () => import('shiki/langs/haskell.mjs'),
  hcl: () => import('shiki/langs/hcl.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  http: () => import('shiki/langs/http.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jinja: () => import('shiki/langs/jinja.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  json5: () => import('shiki/langs/json5.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  just: () => import('shiki/langs/just.mjs'),
  kdl: () => import('shiki/langs/kdl.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  kusto: () => import('shiki/langs/kusto.mjs'),
  latex: () => import('shiki/langs/latex.mjs'),
  less: () => import('shiki/langs/less.mjs'),
  log: () => import('shiki/langs/log.mjs'),
  lua: () => import('shiki/langs/lua.mjs'),
  make: () => import('shiki/langs/make.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  mdx: () => import('shiki/langs/mdx.mjs'),
  nginx: () => import('shiki/langs/nginx.mjs'),
  nix: () => import('shiki/langs/nix.mjs'),
  nushell: () => import('shiki/langs/nushell.mjs'),
  perl: () => import('shiki/langs/perl.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  plsql: () => import('shiki/langs/plsql.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
  prisma: () => import('shiki/langs/prisma.mjs'),
  proto: () => import('shiki/langs/proto.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  r: () => import('shiki/langs/r.mjs'),
  regexp: () => import('shiki/langs/regexp.mjs'),
  ron: () => import('shiki/langs/ron.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  scala: () => import('shiki/langs/scala.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  shellsession: () => import('shiki/langs/shellsession.mjs'),
  solidity: () => import('shiki/langs/solidity.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  'ssh-config': () => import('shiki/langs/ssh-config.mjs'),
  svelte: () => import('shiki/langs/svelte.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  systemd: () => import('shiki/langs/systemd.mjs'),
  terraform: () => import('shiki/langs/terraform.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  viml: () => import('shiki/langs/viml.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  zig: () => import('shiki/langs/zig.mjs'),
};

const LANGUAGE_ALIASES: Record<string, string> = {
  bash: 'shellscript',
  batch: 'bat',
  'c#': 'csharp',
  'c++': 'cpp',
  cjs: 'javascript',
  cmd: 'bat',
  console: 'shellsession',
  cs: 'csharp',
  cts: 'typescript',
  dockerfile: 'docker',
  gql: 'graphql',
  hs: 'haskell',
  js: 'javascript',
  kql: 'kusto',
  kt: 'kotlin',
  kts: 'kotlin',
  makefile: 'make',
  md: 'markdown',
  mjs: 'javascript',
  mts: 'typescript',
  nu: 'nushell',
  patch: 'diff',
  properties: 'ini',
  protobuf: 'proto',
  ps: 'powershell',
  ps1: 'powershell',
  py: 'python',
  rb: 'ruby',
  regex: 'regexp',
  rs: 'rust',
  sh: 'shellscript',
  shell: 'shellscript',
  tf: 'terraform',
  tfvars: 'terraform',
  ts: 'typescript',
  vim: 'viml',
  vimscript: 'viml',
  yml: 'yaml',
  zsh: 'shellscript',
};

const SUPPORTED_LANGUAGES = Object.keys(LANGUAGE_LOADERS) as BundledLanguage[];

const resolveCanonicalLanguage = (language: string): string => {
  const normalized = language.trim().toLowerCase();
  return LANGUAGE_ALIASES[normalized] ?? normalized;
};

const resolveThemeName = (theme: PluginThemeInput, fallback: string): string => {
  if (typeof theme === 'string') {
    return Object.prototype.hasOwnProperty.call(THEME_LOADERS, theme) ? theme : fallback;
  }
  return theme.name ?? 'custom';
};

const getTokensCacheKey = (
  code: string,
  lang: string,
  themeNames: [string, string],
): string => `${lang}:${themeNames[0]}:${themeNames[1]}:${code}`;

export interface FineGrainedCodePluginOptions {
  themes?: [PluginThemeInput, PluginThemeInput];
}

export function createFineGrainedShikiCodePlugin(
  options: FineGrainedCodePluginOptions = {},
): CodeHighlighterPlugin {
  const defaultThemes: [PluginThemeInput, PluginThemeInput] = options.themes ?? DEFAULT_THEMES;
  const engine = createJavaScriptRegexEngine({ forgiving: true });

  let highlighterPromise: Promise<HighlighterCore> | null = null;
  const loadedThemes = new Map<string, Promise<void>>();
  const loadedLanguages = new Map<string, Promise<void>>();
  const tokensCache = new Map<string, HighlightResult>();
  const subscribers = new Map<string, Set<(result: HighlightResult) => void>>();
  const inFlightKeys = new Set<string>();

  const getHighlighter = (): Promise<HighlighterCore> => {
    if (!highlighterPromise) {
      highlighterPromise = createHighlighterCore({
        themes: [],
        langs: [],
        engine,
      }).catch((error) => {
        highlighterPromise = null;
        throw error;
      });
    }
    return highlighterPromise;
  };

  const ensureThemeLoaded = (
    highlighter: HighlighterCore,
    theme: PluginThemeInput,
    fallbackName: string,
  ): Promise<void> => {
    const themeName = resolveThemeName(theme, fallbackName);
    if (highlighter.getLoadedThemes().includes(themeName)) {
      return Promise.resolve();
    }
    const existing = loadedThemes.get(themeName);
    if (existing) return existing;

    const loadPromise = (async () => {
      if (typeof theme === 'string') {
        const loader = THEME_LOADERS[themeName];
        if (!loader) return;
        await highlighter.loadTheme(loader());
        return;
      }
      await highlighter.loadTheme(theme);
    })().catch((error) => {
      loadedThemes.delete(themeName);
      throw error;
    });

    loadedThemes.set(themeName, loadPromise);
    return loadPromise;
  };

  const ensureLanguageLoaded = (
    highlighter: HighlighterCore,
    lang: string,
  ): Promise<void> => {
    if (highlighter.getLoadedLanguages().includes(lang)) {
      return Promise.resolve();
    }
    const loader = LANGUAGE_LOADERS[lang];
    if (!loader) return Promise.resolve();

    const existing = loadedLanguages.get(lang);
    if (existing) return existing;

    const loadPromise = Promise.resolve()
      .then(() => highlighter.loadLanguage(loader))
      .catch((error) => {
        loadedLanguages.delete(lang);
        throw error;
      });

    loadedLanguages.set(lang, loadPromise);
    return loadPromise;
  };

  const setCachedTokens = (key: string, result: HighlightResult): void => {
    if (tokensCache.has(key)) {
      tokensCache.delete(key);
    } else if (tokensCache.size >= MAX_TOKENS_CACHE_ENTRIES) {
      const oldestKey = tokensCache.keys().next().value;
      if (oldestKey !== undefined) tokensCache.delete(oldestKey);
    }
    tokensCache.set(key, result);
  };

  return {
    name: 'shiki',
    type: 'code-highlighter',
    supportsLanguage(language: BundledLanguage): boolean {
      const canonical = resolveCanonicalLanguage(language);
      return Object.prototype.hasOwnProperty.call(LANGUAGE_LOADERS, canonical);
    },
    getSupportedLanguages(): BundledLanguage[] {
      return SUPPORTED_LANGUAGES.slice();
    },
    getThemes(): [PluginThemeInput, PluginThemeInput] {
      return defaultThemes;
    },
    highlight(
      { code, language, themes }: HighlightOptions,
      callback?: (result: HighlightResult) => void,
    ): HighlightResult | null {
      const canonicalLang = resolveCanonicalLanguage(language);
      const themeNames: [string, string] = [
        resolveThemeName(themes[0], 'github-light'),
        resolveThemeName(themes[1], 'github-dark'),
      ];
      const cacheKey = getTokensCacheKey(code, canonicalLang, themeNames);
      const cached = tokensCache.get(cacheKey);
      if (cached) {
        return cached;
      }

      if (callback) {
        let listeners = subscribers.get(cacheKey);
        if (!listeners) {
          listeners = new Set();
          subscribers.set(cacheKey, listeners);
        }
        listeners.add(callback);
      }

      if (inFlightKeys.has(cacheKey)) {
        return null;
      }
      inFlightKeys.add(cacheKey);

      void getHighlighter()
        .then(async (highlighter) => {
          await Promise.all([
            ensureThemeLoaded(highlighter, themes[0], 'github-light'),
            ensureThemeLoaded(highlighter, themes[1], 'github-dark'),
            ensureLanguageLoaded(highlighter, canonicalLang),
          ]);
          const activeLang = highlighter.getLoadedLanguages().includes(canonicalLang)
            ? canonicalLang
            : 'text';
          const tokens = highlighter.codeToTokens(code, {
            lang: activeLang,
            themes: {
              light: themeNames[0],
              dark: themeNames[1],
            },
          });
          setCachedTokens(cacheKey, tokens);
          inFlightKeys.delete(cacheKey);
          const listeners = subscribers.get(cacheKey);
          if (listeners) {
            subscribers.delete(cacheKey);
            for (const listener of listeners) {
              listener(tokens);
            }
          }
        })
        .catch((error) => {
          console.error('[Streamdown Code] Failed to highlight code:', error);
          inFlightKeys.delete(cacheKey);
          subscribers.delete(cacheKey);
        });

      return null;
    },
  };
}

/** Isolated Shiki entry — import this file only through warmAiCodeHighlighter. */
export const streamdownCodePlugin = createSafeCodeHighlighter(
  createFineGrainedShikiCodePlugin(),
);
