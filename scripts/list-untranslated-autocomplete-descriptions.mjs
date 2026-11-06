/**
 * List description strings for the common-command autocomplete overlay that
 * have no zh-CN entry. Maintenance aid for @withfig/autocomplete updates.
 * Not a CI check: always exits 0.
 *
 * Usage: node scripts/list-untranslated-autocomplete-descriptions.mjs
 *
 * Local specs in electron/specs win over the bundled Fig file, matching
 * electron/main/registerBridges.cjs. `docker compose` descriptions come from
 * the docker spec; docker-compose.js covers the standalone command.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dictionaryPath = path.join(
  rootDir,
  "components/terminal/autocomplete/descriptions.zh-CN.json",
);

/** Commands covered by the zh-CN description overlay. */
const COVERED_COMMANDS = [
  "git",
  "docker",
  "docker-compose",
  "kubectl",
  "npm",
  "pnpm",
  "yarn",
  "pip",
  "pip3",
  "systemctl",
  "journalctl",
  "ls",
  "cd",
  "cp",
  "mv",
  "rm",
  "mkdir",
  "chmod",
  "chown",
  "tar",
  "ssh",
  "scp",
  "rsync",
  "curl",
  "wget",
  "grep",
  "find",
  "ps",
  "kill",
  "top",
  "apt",
  "yum",
  "dnf",
  "brew",
  "sudo",
  "touch",
  "cat",
  "tail",
  "head",
  "less",
  "df",
  "du",
  "ip",
  "ping",
  "netstat",
  "ss",
];

function collectDescriptions(node, out, seen) {
  if (!node || typeof node !== "object") return;
  if (seen.has(node)) return;
  seen.add(node);
  if (typeof node.description === "string" && node.description.trim()) {
    out.add(node.description);
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) collectDescriptions(item, out, seen);
    } else if (value && typeof value === "object") {
      collectDescriptions(value, out, seen);
    }
  }
}

function resolveSpecFile(commandName) {
  const localFile = path.join(rootDir, "electron/specs", `${commandName}.js`);
  if (fs.existsSync(localFile)) return localFile;
  const figFile = path.join(
    rootDir,
    "node_modules/@withfig/autocomplete/build",
    `${commandName}.js`,
  );
  if (fs.existsSync(figFile)) return figFile;
  return null;
}

const dictionary = fs.existsSync(dictionaryPath)
  ? JSON.parse(fs.readFileSync(dictionaryPath, "utf8"))
  : {};
const missing = [];
const missingSpecs = [];

for (const commandName of COVERED_COMMANDS) {
  const specFile = resolveSpecFile(commandName);
  if (!specFile) {
    missingSpecs.push(commandName);
    continue;
  }
  const mod = await import(pathToFileURL(specFile).href);
  const raw = mod.default?.default ?? mod.default ?? null;
  if (!raw) {
    missingSpecs.push(commandName);
    continue;
  }
  const spec = JSON.parse(JSON.stringify(raw));
  const descriptions = new Set();
  collectDescriptions(spec, descriptions, new WeakSet());
  for (const description of descriptions) {
    if (typeof dictionary[description] !== "string" || dictionary[description].length === 0) {
      missing.push({ commandName, description });
    }
  }
}

if (missingSpecs.length > 0) {
  console.log(`NO_SPEC ${missingSpecs.join(" ")}`);
}
const seen = new Set();
for (const entry of missing) {
  if (seen.has(entry.description)) continue;
  seen.add(entry.description);
  console.log(`MISSING ${entry.commandName} ${JSON.stringify(entry.description)}`);
}
console.log(`Untranslated description strings: ${seen.size}`);
