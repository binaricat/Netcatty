import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import unusedImports from "eslint-plugin-unused-imports";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default [
  // The recommended preset has no file scope of its own, so scope it off all of
  // electron/ — that main-process tree is historically unlinted. The bridges
  // get a focused rule set in the dedicated block at the end of this config;
  // every other electron/ file matches no config and stays unlinted as before.
  { ...js.configs.recommended, ignores: ["electron/**"] },
  {
    ignores: ["node_modules/**", "dist/**", "scripts/**", "public/monaco/**", ".github/**", ".claude/**", "release/**", "release-build/**", ".worktrees/**"],
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: {
          jsx: true,
        },
      },
      globals: {
        // Browser globals
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        requestAnimationFrame: "readonly",
        cancelAnimationFrame: "readonly",
        fetch: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        FormData: "readonly",
        Blob: "readonly",
        File: "readonly",
        FileReader: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        Event: "readonly",
        EventTarget: "readonly",
        CustomEvent: "readonly",
        MouseEvent: "readonly",
        KeyboardEvent: "readonly",
        DragEvent: "readonly",
        ClipboardEvent: "readonly",
        HTMLElement: "readonly",
        HTMLInputElement: "readonly",
        HTMLTextAreaElement: "readonly",
        HTMLButtonElement: "readonly",
        HTMLDivElement: "readonly",
        HTMLFormElement: "readonly",
        Element: "readonly",
        Node: "readonly",
        NodeList: "readonly",
        MutationObserver: "readonly",
        ResizeObserver: "readonly",
        IntersectionObserver: "readonly",
        localStorage: "readonly",
        sessionStorage: "readonly",
        crypto: "readonly",
        performance: "readonly",
        confirm: "readonly",
        alert: "readonly",
        prompt: "readonly",
        getComputedStyle: "readonly",
        atob: "readonly",
        btoa: "readonly",
        // Node.js globals (for Electron)
        process: "readonly",
        global: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        module: "readonly",
        require: "readonly",
        exports: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      "unused-imports": unusedImports,
      "react-hooks": reactHooks,
    },
    rules: {
      // Disable base rules that conflict with TypeScript
      "no-unused-vars": "off",
      "no-undef": "off", // TypeScript handles this

      // TypeScript unused vars (disabled in favor of unused-imports)
      "@typescript-eslint/no-unused-vars": "off",

      // Disallow any type
      "@typescript-eslint/no-explicit-any": "error",

      // Unused imports plugin - this is the main feature you want
      "unused-imports/no-unused-imports": "warn",
      "unused-imports/no-unused-vars": [
        "warn",
        {
          vars: "all",
          varsIgnorePattern: "^_",
          args: "after-used",
          argsIgnorePattern: "^_",
        },
      ],

      // React Hooks rules
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",

      // Downgrade some rules to warnings (less critical)
      "no-empty": "warn",
      "no-useless-escape": "warn",
      "no-case-declarations": "warn",
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "window",
          property: "netcatty",
          message:
            "Do not access window.netcatty directly; use netcattyBridge or an application/state backend hook.",
        },
      ],
      "no-restricted-globals": ["error", "localStorage", "sessionStorage"],
    },
  },
  {
    files: ["infrastructure/services/netcattyBridge.ts"],
    rules: {
      "no-restricted-properties": "off",
    },
  },
  {
    files: ["infrastructure/persistence/localStorageAdapter.ts"],
    rules: {
      "no-restricted-globals": "off",
    },
  },
  {
    files: ["components/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "../infrastructure/persistence/*",
                "../infrastructure/services/*",
                "../../infrastructure/persistence/*",
                "../../infrastructure/services/*",
              ],
              message:
                "Components should not import infrastructure persistence/services; use application/state hooks instead.",
            },
          ],
        },
      ],
    },
  },
  {
    // Electron main-process bridges are CommonJS and were historically excluded
    // from linting. Lint them for undefined references only — the cheap,
    // high-value guard against e.g. a removed variable still referenced
    // elsewhere. (The TS config disables no-undef because the type-checker
    // already covers it there; these .cjs files have no such safety net.)
    files: ["electron/bridges/**/*.cjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: globals.node,
    },
    linterOptions: {
      // Only no-undef is enabled here, so pre-existing eslint-disable comments
      // for other rules (no-console, no-control-regex, …) would all report as
      // "unused". Don't flag them — they stay valid for future rule additions.
      reportUnusedDisableDirectives: "off",
    },
    rules: {
      "no-undef": "error",
    },
  },
];
