import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import test from "node:test";

import {
  assertManifestSnapshotMatches,
  buildPluginPackage,
  extractPluginPackage,
  hashFile,
  validatePluginDirectory,
  validatePluginPackage,
} from "./archive.ts";
import { checkPluginCompatibility } from "./compatibility.ts";
import { PACKAGE_LIMITS } from "./constants.ts";
import { initPlugin } from "./commands.ts";
import {
  parseAndValidateManifestContents,
  readAndValidateManifest,
  validateManifestValue,
} from "./manifest.ts";
import { assertSafePackagePath, PackagePathRegistry } from "./packagePath.ts";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

function crc32(contents: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of contents) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZipEntry(
  entryName: string,
  contents: Buffer,
  options: {
    readonly compressionMethod?: 0 | 8;
    readonly declaredUncompressedSize?: number;
  } = {},
): Buffer {
  const compressionMethod = options.compressionMethod ?? 0;
  const encodedContents = compressionMethod === 8 ? deflateRawSync(contents) : contents;
  const declaredUncompressedSize = options.declaredUncompressedSize ?? contents.byteLength;
  const encodedName = Buffer.from(entryName);
  const checksum = crc32(contents);
  const localHeader = Buffer.alloc(30 + encodedName.byteLength);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0x0800, 6);
  localHeader.writeUInt16LE(compressionMethod, 8);
  localHeader.writeUInt16LE(0, 10);
  localHeader.writeUInt16LE(33, 12);
  localHeader.writeUInt32LE(checksum, 14);
  localHeader.writeUInt32LE(encodedContents.byteLength, 18);
  localHeader.writeUInt32LE(declaredUncompressedSize, 22);
  localHeader.writeUInt16LE(encodedName.byteLength, 26);
  encodedName.copy(localHeader, 30);

  const centralHeader = Buffer.alloc(46 + encodedName.byteLength);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0x0800, 8);
  centralHeader.writeUInt16LE(compressionMethod, 10);
  centralHeader.writeUInt16LE(0, 12);
  centralHeader.writeUInt16LE(33, 14);
  centralHeader.writeUInt32LE(checksum, 16);
  centralHeader.writeUInt32LE(encodedContents.byteLength, 20);
  centralHeader.writeUInt32LE(declaredUncompressedSize, 24);
  centralHeader.writeUInt16LE(encodedName.byteLength, 28);
  centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  centralHeader.writeUInt32LE(0, 42);
  encodedName.copy(centralHeader, 46);

  const centralOffset = localHeader.byteLength + encodedContents.byteLength;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralHeader.byteLength, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([localHeader, encodedContents, centralHeader, end]);
}

function replaceCentralEntryMode(archive: Buffer, entryName: string, mode: number): Buffer {
  const result = Buffer.from(archive);
  const endOffset = result.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endOffset < 0) throw new Error("Missing ZIP end record");
  const entryCount = result.readUInt16LE(endOffset + 10);
  let offset = result.readUInt32LE(endOffset + 16);
  for (let entry = 0; entry < entryCount; entry += 1) {
    if (result.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid central ZIP entry");
    const nameLength = result.readUInt16LE(offset + 28);
    const extraLength = result.readUInt16LE(offset + 30);
    const commentLength = result.readUInt16LE(offset + 32);
    const name = result.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (name === entryName) {
      result.writeUInt32LE((mode << 16) >>> 0, offset + 38);
      return result;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`Missing central ZIP entry: ${entryName}`);
}

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    manifestVersion: 1,
    id: "com.example.package-test",
    name: "package-test",
    version: "1.0.0",
    publisher: "example",
    engines: { netcatty: ">=1.0.0 <2.0.0", api: ">=0.1.0-internal <0.2.0" },
    main: { browser: "dist/index.js" },
    ...overrides,
  };
}

async function createPlugin(root: string): Promise<string> {
  const directory = path.join(root, "plugin");
  await mkdir(path.join(directory, "dist"), { recursive: true });
  await Promise.all([
    writeFile(
      path.join(directory, "netcatty.plugin.json"),
      `${JSON.stringify(manifest(), null, 2)}\n`,
    ),
    writeFile(path.join(directory, "dist/index.js"), "export default {};\n"),
    writeFile(path.join(directory, "README.md"), "# Package test\n"),
  ]);
  return directory;
}

test("path validation rejects traversal, platform aliases, and duplicates", () => {
  for (const unsafe of [
    "../escape",
    "/absolute",
    "C:/drive",
    "a\\b",
    "a/../b",
    "CON",
    "assets/PRN.txt",
    "file.",
    "folder/file ",
    "folder/file?.js",
    "a//b",
    "a／b",
    "a＼b",
    "．．/x",
    "．．",
    "Ｃ：/x",
    "assets/ＣＯＮ.txt",
    "file．",
    "😀".repeat(129),
  ]) {
    assert.throws(() => assertSafePackagePath(unsafe));
  }
  assert.equal(assertSafePackagePath("😀".repeat(128)), "😀".repeat(128));
  assert.equal(assertSafePackagePath("assets/fullwidth-Ｓ.txt"), "assets/fullwidth-Ｓ.txt");
  const registry = new PackagePathRegistry();
  registry.add("dist/Plugin.js");
  assert.throws(() => registry.add("dist/plugin.js"), /case-colliding/);

  for (const [first, second] of [
    ["assets/Straße.txt", "assets/STRASSE.txt"],
    ["assets/fullwidth-Ｓ.txt", "assets/fullwidth-S.txt"],
  ]) {
    const unicodeRegistry = new PackagePathRegistry();
    unicodeRegistry.add(first);
    assert.throws(() => unicodeRegistry.add(second), /case-colliding/);
  }

  for (const paths of [
    ["dist", "dist/index.js"],
    ["dist/index.js", "dist"],
    ["DIST", "dist/index.js"],
    ["dist/index.js", "DIST"],
  ]) {
    const collisionRegistry = new PackagePathRegistry();
    collisionRegistry.add(paths[0]);
    assert.throws(
      () => collisionRegistry.add(paths[1]),
      /File\/directory package path collision/,
    );
  }
});

test("manifest validation reports permission and contribution mistakes", () => {
  const result = validateManifestValue(manifest({
    permissions: {
      required: [{ permission: "network", resources: ["https://example.com"] }],
      optional: ["network"],
    },
    contributes: {
      commands: [{ id: "com.example.package-test.run", title: "Run" }],
      menus: [{ command: "com.example.package-test.missing", location: "commandPalette" }],
    },
  }));
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /both required and optional/);
  assert.match(result.errors.join("\n"), /undeclared command/);
});

test("text setting defaults must satisfy their declared pattern", () => {
  const result = validateManifestValue(manifest({
    permissions: { required: ["settings.read", "settings.write"] },
    contributes: {
      settings: [{
        id: "com.example.package-test.channel",
        label: "Channel",
        control: "text",
        scope: "application",
        pattern: "^(stable|beta)$",
        default: "nightly",
      }],
    },
  }));

  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /default does not match its pattern/u);
});

test("resource-scoped required permissions must declare activation-time bounds", () => {
  for (const [permission, resource] of [
    ["network", "https://example.com"],
    ["filesystem.read", "/tmp/plugin-read"],
    ["filesystem.write", "/tmp/plugin-write"],
    ["companion.execute", "com.example.package-test.helper"],
  ] as const) {
    const unbounded = validateManifestValue(manifest({
      permissions: { required: [permission] },
    }));
    assert.equal(unbounded.valid, false, permission);
    assert.match(unbounded.errors.join("\n"), /must declare explicit resources/u);

    const bounded = validateManifestValue(manifest({
      permissions: { required: [{ permission, resources: [resource] }] },
    }));
    assert.equal(bounded.valid, true, bounded.errors.join("\n"));

    const wildcard = validateManifestValue(manifest({
      permissions: { required: [{ permission, resources: ["*"] }] },
    }));
    assert.equal(wildcard.valid, false, permission);
    assert.match(wildcard.errors.join("\n"), /must not use the wildcard resource/u);

    const optional = validateManifestValue(manifest({
      permissions: { optional: [permission] },
    }));
    assert.equal(optional.valid, true, optional.errors.join("\n"));
  }
});

test("manifest validation applies the runtime resource limit for each permission", () => {
  for (const [permission, length, expectedLimit] of [
    ["network", 2_049, 2_048],
    ["storage", 2_049, 2_048],
    ["companion.execute", 193, 192],
  ] as const) {
    const result = validateManifestValue(manifest({
      permissions: permission === "storage"
        ? { optional: [{ permission, resources: ["x".repeat(length)] }] }
        : { required: [{ permission, resources: ["x".repeat(length)] }] },
    }));
    assert.equal(result.valid, false);
    assert.match(
      result.errors.join("\n"),
      new RegExp(`Permission resource for ${permission.replace(".", "\\.")} exceeds ${expectedLimit}`),
    );
  }

  const filesystem = validateManifestValue(manifest({
    permissions: {
      required: [{ permission: "filesystem.read", resources: [`/${"x".repeat(4_096)}`] }],
    },
  }));
  assert.equal(filesystem.valid, true, filesystem.errors.join("\n"));
});

test("Node utility entrypoints require the explicit advanced-runtime permission", () => {
  const missing = validateManifestValue(manifest({
    main: { node: "dist/index.js" },
  }));
  assert.equal(missing.valid, false);
  assert.match(missing.errors.join("\n"), /requires declared permission: runtime\.advanced/);

  const declared = validateManifestValue(manifest({
    main: { node: "dist/index.js" },
    permissions: { required: ["runtime.advanced"] },
  }));
  assert.equal(declared.valid, true, declared.errors.join("\n"));
});

test("manifest byte parsing rejects invalid UTF-8 before JSON validation", () => {
  const validContents = new TextEncoder().encode(JSON.stringify(manifest()));
  assert.equal(parseAndValidateManifestContents(validContents).id, "com.example.package-test");
  assert.throws(
    () => parseAndValidateManifestContents(Uint8Array.from([0x7b, 0x22, 0xff, 0x22, 0x7d])),
    /not valid UTF-8 JSON/,
  );
});

test("manifest validation safely rejects excessive JSON nesting", () => {
  let nested: unknown = null;
  for (let depth = 0; depth < 5_000; depth += 1) {
    nested = [nested];
  }
  const result = validateManifestValue(manifest({
    permissions: { required: ["commands"] },
    contributes: {
      commands: [{ id: "com.example.package-test.run", title: "Run" }],
      keybindings: [{
        command: "com.example.package-test.run",
        key: "ctrl+x",
        args: nested,
      }],
    },
  }));
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /must not exceed .* levels/);

  const wideResult = validateManifestValue(manifest({
    permissions: { required: ["commands"] },
    contributes: {
      commands: [{ id: "com.example.package-test.run", title: "Run" }],
      keybindings: [{
        command: "com.example.package-test.run",
        key: "ctrl+x",
        args: Array.from({ length: 100_000 }, () => null),
      }],
    },
  }));
  assert.equal(wideResult.valid, false);
  assert.match(wideResult.errors.join("\n"), /must not contain more than .* nodes/);
});

test("manifest validation rejects duplicate companion executable paths", () => {
  const result = validateManifestValue(manifest({
    companionExecutables: [
      {
        id: "com.example.package-test.helper-one",
        variants: [{
          path: "bin/helper",
          platforms: ["linux-x64"],
          sha256: "0".repeat(64),
        }],
      },
      {
        id: "com.example.package-test.helper-two",
        variants: [{
          path: "bin/helper",
          platforms: ["darwin-arm64"],
          sha256: "1".repeat(64),
        }],
      },
    ],
  }));

  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /Duplicate companion executable path: bin\/helper/);
});

test("manifest validation supports platform-specific companion variants", () => {
  const result = validateManifestValue(manifest({
    main: { browser: "dist/index.js", node: "dist/index.js" },
    permissions: {
      required: [
        "runtime.advanced",
        {
          permission: "companion.execute",
          resources: ["com.example.package-test.helper"],
        },
      ],
    },
    companionExecutables: [{
      id: "com.example.package-test.helper",
      variants: [
        {
          path: "bin/helper-darwin",
          platforms: ["darwin-arm64", "darwin-x64"],
          sha256: "0".repeat(64),
        },
        {
          path: "bin/helper-linux",
          platforms: ["linux-arm64", "linux-x64"],
          sha256: "1".repeat(64),
        },
      ],
    }],
  }));
  assert.equal(result.valid, true, result.errors.join("\n"));

  const duplicatePlatform = validateManifestValue(manifest({
    main: { browser: "dist/index.js", node: "dist/index.js" },
    permissions: {
      required: [
        "runtime.advanced",
        {
          permission: "companion.execute",
          resources: ["com.example.package-test.helper"],
        },
      ],
    },
    companionExecutables: [{
      id: "com.example.package-test.helper",
      variants: [
        {
          path: "bin/helper-one",
          platforms: ["linux-x64"],
          sha256: "0".repeat(64),
        },
        {
          path: "bin/helper-two",
          platforms: ["linux-x64"],
          sha256: "1".repeat(64),
        },
      ],
    }],
  }));
  assert.equal(duplicatePlatform.valid, false);
  assert.match(duplicatePlatform.errors.join("\n"), /Duplicate companion platform/);
});

test("companion executables require an advanced utility placement", () => {
  const companionExecutables = [{
    id: "com.example.package-test.helper",
    variants: [{
      path: "bin/helper",
      platforms: ["linux-x64"],
      sha256: "0".repeat(64),
    }],
  }];
  const companionPermission = {
    permission: "companion.execute" as const,
    resources: ["com.example.package-test.helper"],
  };

  const browserOnly = validateManifestValue(manifest({
    permissions: { required: [companionPermission] },
    companionExecutables,
  }));
  assert.equal(browserOnly.valid, false);
  assert.match(browserOnly.errors.join("\n"), /require a Node utility entrypoint/u);

  const missingAdvanced = validateManifestValue(manifest({
    main: { browser: "dist/index.js", node: "dist/index.js" },
    permissions: { required: [companionPermission] },
    companionExecutables,
  }));
  assert.equal(missingAdvanced.valid, false);
  assert.match(missingAdvanced.errors.join("\n"), /requires declared permission: runtime\.advanced/u);
});

test("packaging treats contributed package icons as required safe files", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "netcatty-plugin-icons-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = await createPlugin(root);
  const manifestPath = path.join(directory, "netcatty.plugin.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest({
    permissions: { required: ["commands"] },
    contributes: {
      commands: [{
        id: "com.example.package-test.run",
        title: "Run",
        icon: {
          kind: "package",
          light: "assets/run-light.svg",
          dark: "assets/run-dark.svg",
        },
      }],
    },
  }), null, 2)}\n`);

  await assert.rejects(
    buildPluginPackage(directory, path.join(root, "missing-icons.ncpkg")),
    /missing package file: assets\/run-light\.svg/,
  );

  await mkdir(path.join(directory, "assets"));
  await Promise.all([
    writeFile(path.join(directory, "assets/run-light.svg"), "<svg></svg>"),
    writeFile(path.join(directory, "assets/run-dark.svg"), "<svg></svg>"),
  ]);
  const output = path.join(root, "with-icons.ncpkg");
  await buildPluginPackage(directory, output);
  const result = await validatePluginPackage(output);
  assert.equal(result.manifest.id, "com.example.package-test");
});

test("compatibility checks engine ranges and negotiates declared features", () => {
  const pluginManifest = manifest({
    features: {
      required: ["netcatty.rpc.progress"],
      optional: ["netcatty.stream.binary", "netcatty.view.theme"],
    },
  });
  const compatible = checkPluginCompatibility(pluginManifest, {
    netcattyVersion: "1.4.0",
    features: ["netcatty.rpc.progress", "netcatty.stream.binary"],
  });
  assert.equal(compatible.compatible, true);
  assert.deepEqual(compatible.enabledFeatures, [
    "netcatty.rpc.progress",
    "netcatty.stream.binary",
  ]);

  const incompatible = checkPluginCompatibility(pluginManifest, {
    netcattyVersion: "2.0.0",
    apiVersion: "0.2.0",
    features: [],
  });
  assert.equal(incompatible.compatible, false);
  assert.deepEqual(incompatible.missingRequiredFeatures, ["netcatty.rpc.progress"]);
  assert.match(incompatible.errors.join("\n"), /does not satisfy/);
  assert.match(incompatible.errors.join("\n"), /Missing required features/);

  const nextApiPrerelease = checkPluginCompatibility(pluginManifest, {
    netcattyVersion: "1.4.0",
    apiVersion: "0.2.0-alpha.1",
    features: ["netcatty.rpc.progress"],
  });
  assert.equal(nextApiPrerelease.compatible, false);
  assert.match(nextApiPrerelease.errors.join("\n"), /plugin API version .* does not satisfy/);
});

test("compatibility CLI checks a validated plugin target", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "netcatty-plugin-compatibility-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = await createPlugin(root);

  const compatible = await execFileAsync(process.execPath, [
    "--import",
    "tsx",
    cliPath,
    "compatibility",
    directory,
    "--netcatty",
    "1.5.0",
  ]);
  assert.match(compatible.stdout, /Compatible: com\.example\.package-test@1\.0\.0/);

  await assert.rejects(
    execFileAsync(process.execPath, [
      "--import",
      "tsx",
      cliPath,
      "compatibility",
      directory,
      "--netcatty",
      "2.0.0",
    ]),
    /Plugin is incompatible/,
  );
});

test("example README commands use repository-root CLI paths", async () => {
  const readme = await readFile(
    path.join(repositoryRoot, "examples/plugins/hello-netcatty/README.md"),
    "utf8",
  );

  assert.match(readme, /npm run build:plugin-packages/);
  assert.match(
    readme,
    /node packages\/plugin-cli\/dist\/cli\.js validate examples\/plugins\/hello-netcatty/,
  );
  assert.match(
    readme,
    /node packages\/plugin-cli\/dist\/cli\.js compatibility examples\/plugins\/hello-netcatty --netcatty 0\.0\.0/,
  );
  assert.doesNotMatch(readme, /npm exec --workspace @netcatty\/plugin-cli/);
});

test("init creates a valid TypeScript plugin skeleton", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "netcatty-plugin-init-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "created");

  await initPlugin(directory, { id: "com.example.created", name: "Created" });

  const createdManifest = await readAndValidateManifest(directory);
  assert.equal(createdManifest.id, "com.example.created");
  assert.match(await readFile(path.join(directory, "src/index.ts"), "utf8"), /definePlugin/);
});

test("init safely serializes the display name in generated TypeScript", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "netcatty-plugin-init-escape-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "created");
  const displayName = 'A "quoted" \\ plugin\nnext line';

  await initPlugin(directory, { id: "com.example.escaped", name: displayName });

  const source = await readFile(path.join(directory, "src/index.ts"), "utf8");
  assert.ok(
    source.includes(`context.logger.info(${JSON.stringify(`${displayName} activated`)});`),
  );
});

test("packing is deterministic and the archive validates", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "netcatty-plugin-pack-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = await createPlugin(root);
  const first = path.join(root, "first.ncpkg");
  const second = path.join(root, "second.ncpkg");

  const firstResult = await buildPluginPackage(directory, first);
  await buildPluginPackage(directory, second);
  const firstBytes = await readFile(first);
  const secondBytes = await readFile(second);

  assert.deepEqual(firstBytes, secondBytes);
  assert.equal(
    firstResult.sha256,
    createHash("sha256").update(firstBytes).digest("hex"),
  );
  const validation = await validatePluginPackage(first);
  const directoryValidation = await validatePluginDirectory(directory);
  assert.equal(validation.manifest.id, "com.example.package-test");
  assert.equal(validation.fileCount, 3);
  assert.equal(firstResult.contentSha256, validation.contentSha256);
  assert.equal(validation.contentSha256, directoryValidation.contentSha256);
  assert.match(validation.contentSha256, /^[a-f0-9]{64}$/u);
});

test("logical content identity follows companion declarations across ZIP mode encoders", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "netcatty-plugin-companion-mode-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = await createPlugin(root);
  const companionContents = Buffer.from("portable companion\n");
  const companionPath = path.join(directory, "bin/helper");
  await mkdir(path.dirname(companionPath), { recursive: true });
  await writeFile(companionPath, companionContents);
  await writeFile(
    path.join(directory, "netcatty.plugin.json"),
    `${JSON.stringify(manifest({
      main: { browser: "dist/index.js", node: "dist/index.js" },
      permissions: {
        required: [
          "runtime.advanced",
          {
            permission: "companion.execute",
            resources: ["com.example.package-test.helper"],
          },
        ],
      },
      companionExecutables: [{
        id: "com.example.package-test.helper",
        variants: [{
          path: "bin/helper",
          platforms: ["linux-x64"],
          sha256: createHash("sha256").update(companionContents).digest("hex"),
        }],
      }],
    }), null, 2)}\n`,
  );
  const builtPath = path.join(root, "built.ncpkg");
  const portablePath = path.join(root, "portable.ncpkg");
  const extracted = path.join(root, "extracted");
  await buildPluginPackage(directory, builtPath);
  await writeFile(
    portablePath,
    replaceCentralEntryMode(await readFile(builtPath), "bin/helper", 0o100644),
  );

  const archiveValidation = await extractPluginPackage(portablePath, extracted);
  const directoryValidation = await validatePluginDirectory(extracted, {
    allowIgnoredRootEntries: false,
  });
  assert.equal(archiveValidation.contentSha256, directoryValidation.contentSha256);
});

test("validated extraction creates an isolated tree and removes partial output on failure", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "netcatty-plugin-extract-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = await createPlugin(root);
  const archive = path.join(root, "plugin.ncpkg");
  const extracted = path.join(root, "extracted");
  await buildPluginPackage(directory, archive);

  const result = await extractPluginPackage(archive, extracted);
  assert.equal(result.manifest.id, "com.example.package-test");
  assert.equal(
    await readFile(path.join(extracted, "dist/index.js"), "utf8"),
    "export default {};\n",
  );
  await assert.rejects(extractPluginPackage(archive, extracted));
  assert.equal(
    await readFile(path.join(extracted, "dist/index.js"), "utf8"),
    "export default {};\n",
  );

  const invalidArchive = path.join(root, "invalid.ncpkg");
  const failedDestination = path.join(root, "failed-extraction");
  await writeFile(invalidArchive, "not a zip");
  await assert.rejects(extractPluginPackage(invalidArchive, failedDestination));
  await assert.rejects(readFile(failedDestination), /ENOENT/);
});

test("archive validation rejects oversized manifests before buffering", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "netcatty-plugin-archive-manifest-limit-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const oversizedPath = path.join(root, "oversized-manifest.ncpkg");
  const oversizedBytes = createZipEntry(
    "netcatty.plugin.json",
    Buffer.alloc(PACKAGE_LIMITS.manifestBytes + 1, 0x20),
  );
  await writeFile(oversizedPath, oversizedBytes);

  await assert.rejects(
    validatePluginPackage(oversizedPath),
    new RegExp(`Plugin manifest exceeds ${PACKAGE_LIMITS.manifestBytes} bytes`),
  );

  const forgedSizePath = path.join(root, "forged-size-manifest.ncpkg");
  const forgedSizeBytes = createZipEntry(
    "netcatty.plugin.json",
    Buffer.alloc(PACKAGE_LIMITS.manifestBytes + 1, 0x20),
    {
      compressionMethod: 8,
      declaredUncompressedSize: PACKAGE_LIMITS.manifestBytes,
    },
  );
  await writeFile(forgedSizePath, forgedSizeBytes);

  await assert.rejects(
    validatePluginPackage(forgedSizePath),
    new RegExp(
      `too many bytes in the stream\\. expected ${PACKAGE_LIMITS.manifestBytes}\\. got at least ${PACKAGE_LIMITS.manifestBytes + 1}`,
    ),
  );
});

test("archive validation rejects duplicate names and CRC corruption", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "netcatty-plugin-archive-safety-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = await createPlugin(root);
  await Promise.all([
    writeFile(path.join(directory, "a.txt"), "first\n"),
    writeFile(path.join(directory, "b.txt"), "second\n"),
  ]);
  await mkdir(path.join(directory, "bbbbb"));
  await Promise.all([
    writeFile(path.join(directory, "aaaaa"), "parent-file\n"),
    writeFile(path.join(directory, "bbbbb/file"), "child-file\n"),
  ]);
  const validPath = path.join(root, "valid.ncpkg");
  await buildPluginPackage(directory, validPath);
  const validBytes = await readFile(validPath);

  const duplicateBytes = Buffer.from(validBytes);
  const originalName = Buffer.from("b.txt");
  const duplicateName = Buffer.from("a.txt");
  let replacements = 0;
  for (let offset = duplicateBytes.indexOf(originalName); offset !== -1;) {
    duplicateName.copy(duplicateBytes, offset);
    replacements += 1;
    offset = duplicateBytes.indexOf(originalName, offset + originalName.byteLength);
  }
  assert.equal(replacements, 2, "ZIP should contain the local and central entry names");
  const duplicatePath = path.join(root, "duplicate.ncpkg");
  await writeFile(duplicatePath, duplicateBytes);
  await assert.rejects(validatePluginPackage(duplicatePath), /Duplicate or case-colliding/);

  const prefixCollisionBytes = Buffer.from(validBytes);
  let prefixReplacements = 0;
  for (const [source, target] of [
    [Buffer.from("aaaaa"), Buffer.from("distx")],
    [Buffer.from("bbbbb/file"), Buffer.from("distx/file")],
  ]) {
    for (let offset = prefixCollisionBytes.indexOf(source); offset !== -1;) {
      target.copy(prefixCollisionBytes, offset);
      prefixReplacements += 1;
      offset = prefixCollisionBytes.indexOf(source, offset + source.byteLength);
    }
  }
  assert.equal(prefixReplacements, 4, "ZIP should contain both local and central names");
  const prefixCollisionPath = path.join(root, "prefix-collision.ncpkg");
  await writeFile(prefixCollisionPath, prefixCollisionBytes);
  await assert.rejects(
    validatePluginPackage(prefixCollisionPath),
    /File\/directory package path collision/,
  );

  const corruptedBytes = Buffer.from(validBytes);
  const content = Buffer.from("# Package test\n");
  const contentOffset = corruptedBytes.indexOf(content);
  assert.notEqual(contentOffset, -1);
  corruptedBytes[contentOffset] ^= 0x01;
  const corruptedPath = path.join(root, "corrupted.ncpkg");
  await writeFile(corruptedPath, corruptedBytes);
  await assert.rejects(validatePluginPackage(corruptedPath), /integrity check failed/);

  const splitNameBytes = Buffer.from(validBytes);
  const localName = Buffer.from("README.md");
  const conflictingLocalName = Buffer.from("renamed.x");
  assert.equal(localName.byteLength, conflictingLocalName.byteLength);
  const localNameOffset = splitNameBytes.indexOf(localName);
  assert.notEqual(localNameOffset, -1);
  conflictingLocalName.copy(splitNameBytes, localNameOffset);
  const splitNamePath = path.join(root, "split-name.ncpkg");
  await writeFile(splitNamePath, splitNameBytes);
  await assert.rejects(
    validatePluginPackage(splitNamePath),
    /local and central entry names differ/,
  );
});

test("packer rejects symbolic links and undeclared executables", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "netcatty-plugin-safety-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = await createPlugin(root);
  await assert.rejects(
    buildPluginPackage(directory, path.join(root, "wrong-extension.zip")),
    /\.ncpkg extension/,
  );
  if (process.platform !== "win32") {
    await symlink("README.md", path.join(directory, "linked-readme"));
    await assert.rejects(
      buildPluginPackage(directory, path.join(root, "symlink.ncpkg")),
      /Symbolic links/,
    );
    await rm(path.join(directory, "linked-readme"));
  }
  await mkdir(path.join(directory, "bin"));
  const executablePath = path.join(directory, "bin/tool.exe");
  await writeFile(executablePath, "not-a-real-executable\n");
  await assert.rejects(
    buildPluginPackage(directory, path.join(root, "executable.ncpkg")),
    /not declared as a companion/,
  );
});

test("packer ignores root dev artifacts without dropping nested runtime dependencies", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "netcatty-plugin-runtime-deps-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = await createPlugin(root);
  await Promise.all([
    mkdir(path.join(directory, "node_modules/dev-only"), { recursive: true }),
    mkdir(path.join(directory, "dist/node_modules/runtime-dependency"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(directory, "node_modules/dev-only/index.js"), "dev only\n"),
    writeFile(
      path.join(directory, "dist/node_modules/runtime-dependency/index.js"),
      "export const runtime = true;\n",
    ),
  ]);
  const packagePath = path.join(root, "runtime-deps.ncpkg");

  const build = await buildPluginPackage(directory, packagePath);
  const validation = await validatePluginPackage(packagePath);

  assert.equal(build.fileCount, 4);
  assert.equal(validation.fileCount, 4);
});

test("packer rejects outputs inside the plugin source tree", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "netcatty-plugin-output-containment-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = await createPlugin(root);
  const nestedOutput = path.join(directory, "dist/plugin.ncpkg");
  await writeFile(nestedOutput, "previous package output\n");

  await assert.rejects(
    buildPluginPackage(directory, nestedOutput),
    /output must be outside the plugin source directory/,
  );

  if (process.platform !== "win32") {
    const outputAlias = path.join(root, "output-alias");
    await symlink(path.join(directory, "dist"), outputAlias);
    await assert.rejects(
      buildPluginPackage(directory, path.join(outputAlias, "plugin.ncpkg")),
      /output must be outside the plugin source directory/,
    );
  }
});

test("manifest byte limit is enforced before JSON parsing", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "netcatty-plugin-limit-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, "netcatty.plugin.json");
  await writeFile(manifestPath, "{}");
  await truncate(manifestPath, PACKAGE_LIMITS.manifestBytes * 4);
  await assert.rejects(readAndValidateManifest(root), /manifest exceeds/);
});

test("manifest validation refuses symlinked source manifests", async (context) => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(path.join(tmpdir(), "netcatty-plugin-manifest-link-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "target.json");
  await writeFile(target, JSON.stringify(manifest()));
  await symlink(target, path.join(root, "netcatty.plugin.json"));
  await assert.rejects(readAndValidateManifest(root), /must be a regular file/);
});

test("validated manifest snapshots reject changed package bytes", () => {
  const snapshot = { size: 128, sha256: "a".repeat(64) };
  assert.doesNotThrow(() => assertManifestSnapshotMatches(snapshot, snapshot));
  assert.throws(
    () => assertManifestSnapshotMatches(snapshot, { ...snapshot, size: 129 }),
    /manifest changed after validation/,
  );
  assert.throws(
    () => assertManifestSnapshotMatches(snapshot, { ...snapshot, sha256: "b".repeat(64) }),
    /manifest changed after validation/,
  );
  assert.throws(
    () => assertManifestSnapshotMatches(snapshot, undefined),
    /manifest changed after validation/,
  );
});

test("source hashing enforces its byte budget while reading", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "netcatty-plugin-source-limit-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "growing.bin");
  await writeFile(filePath, "1234");

  await assert.rejects(hashFile(filePath, 3), /source exceeds 3 bytes while reading/);
  assert.equal((await hashFile(filePath, 4)).size, 4);
});
