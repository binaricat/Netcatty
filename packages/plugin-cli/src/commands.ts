import { spawn } from "node:child_process";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PluginManifest } from "@netcatty/plugin-contract";

import {
  buildPluginPackage,
  validatePluginDirectory,
  validatePluginPackage,
} from "./archive.js";
import { readAndValidateManifest } from "./manifest.js";

export interface InitPluginOptions {
  readonly id: string;
  readonly name?: string;
}

export async function initPlugin(
  targetDirectory: string,
  options: InitPluginOptions,
): Promise<string> {
  const directory = path.resolve(targetDirectory);
  await mkdir(directory, { recursive: true });
  const existingEntries = await readdir(directory);
  if (existingEntries.length > 0) {
    throw new Error(`Target directory is not empty: ${directory}`);
  }
  const displayName = options.name?.trim() || options.id.split(".").at(-1) || options.id;
  const activationMessage = JSON.stringify(`${displayName} activated`);
  const packageName = options.id.replaceAll(".", "-");
  const manifest: PluginManifest = {
    $schema: "https://netcatty.com/schemas/plugins/0.1.0-internal.1/plugin-contract.schema.json",
    manifestVersion: 1,
    id: options.id,
    name: displayName,
    displayName,
    description: "A Netcatty plugin",
    version: "0.1.0",
    publisher: options.id.split(".")[0] || "local",
    engines: {
      netcatty: ">=0.0.0",
      api: ">=0.1.0-internal <0.2.0",
    },
    main: { browser: "dist/index.js" },
    activationEvents: ["onStartupFinished"],
    permissions: { required: [], optional: [] },
  };
  await mkdir(path.join(directory, "src"), { recursive: true });
  await Promise.all([
    writeFile(
      path.join(directory, "netcatty.plugin.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      path.join(directory, "package.json"),
      `${JSON.stringify({
        name: packageName,
        version: "0.1.0",
        private: true,
        type: "module",
        scripts: { build: "tsc -p tsconfig.json" },
        dependencies: { "@netcatty/plugin-sdk": "0.1.0-internal.1" },
        devDependencies: { typescript: "^5.9.0" },
      }, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      path.join(directory, "tsconfig.json"),
      `${JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          declaration: true,
          rootDir: "src",
          outDir: "dist",
        },
        include: ["src/**/*.ts"],
      }, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      path.join(directory, "src/index.ts"),
      `import { definePlugin } from "@netcatty/plugin-sdk";\n\nexport default definePlugin({\n  activate(context) {\n    context.logger.info(${activationMessage});\n  },\n});\n`,
      "utf8",
    ),
  ]);
  await readAndValidateManifest(directory);
  return directory;
}

export async function validateTarget(target: string) {
  const resolved = path.resolve(target);
  const targetStats = await stat(resolved);
  if (targetStats.isDirectory()) {
    const result = await validatePluginDirectory(resolved);
    return { kind: "directory" as const, ...result };
  }
  if (targetStats.isFile() && resolved.endsWith(".ncpkg")) {
    const result = await validatePluginPackage(resolved);
    return { kind: "package" as const, ...result };
  }
  throw new Error("Validation target must be a plugin directory or .ncpkg file");
}

export async function buildPlugin(pluginDirectory: string): Promise<void> {
  const directory = path.resolve(pluginDirectory);
  await readAndValidateManifest(directory);
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(npmCommand, ["run", "build", "--if-present"], {
      cwd: directory,
      env: process.env,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Plugin build failed (${signal ?? `exit ${String(code)}`})`));
    });
  });
  await validatePluginDirectory(directory);
}

export async function packPlugin(pluginDirectory: string, outputPath?: string) {
  const directory = path.resolve(pluginDirectory);
  const manifest = await readAndValidateManifest(directory);
  const resolvedOutput = outputPath
    ? path.resolve(outputPath)
    : path.join(path.dirname(directory), `${manifest.id}-${manifest.version}.ncpkg`);
  return buildPluginPackage(directory, resolvedOutput);
}
