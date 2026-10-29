import fs from "node:fs/promises";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPluginPackage } from "@netcatty/plugin-cli";
import { build } from "esbuild";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { canonicalizeStreamEndpoint, isLocalControlAddress } = require("../../../electron/plugins/byteStreamEndpoint.cjs");
const { isIP } = require("node:net");
const root = path.dirname(fileURLToPath(import.meta.url));

export async function prepareDatabaseExample(targetEndpoint, outputPath) {
  const { endpoint, transport, host } = canonicalizeStreamEndpoint(targetEndpoint);
  // This preparation tool only targets a disposable private IPv4 fixture.
  // The generic host capability has no database restriction or protocol logic.
  if (transport !== "tcp" || isIP(host) !== 4 || isLocalControlAddress(host)
    || !/^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/u.test(host)) throw new Error("Use the isolated fixture's private IPv4 TCP endpoint");
  const temporary = await fs.mkdtemp(path.join(path.dirname(outputPath), ".database-example-"));
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(root, "netcatty.plugin.json"), "utf8"));
    manifest.permissions.optional[0].resources = [endpoint];
    await fs.writeFile(path.join(temporary, "netcatty.plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    for (const file of ["browser.js", "protocol.mjs", "panel.js", "host.js", "view.html", "view.css"]) await fs.copyFile(path.join(root, file), path.join(temporary, file));
    await fs.writeFile(path.join(temporary, "fixture-config.mjs"), `export const endpoint = ${JSON.stringify(endpoint)};\n`);
    const bundle = await build({ entryPoints: [path.join(temporary, "host.js")], write: false,
      loader: { ".html": "text", ".css": "text" }, bundle: true, minify: true, platform: "browser", format: "esm", nodePaths: [path.resolve(root, "../../../node_modules")] });
    await fs.writeFile(path.join(temporary, "browser.js"), bundle.outputFiles[0].contents);
    for (const file of ["protocol.mjs", "fixture-config.mjs", "panel.js", "host.js", "view.html", "view.css"]) await fs.rm(path.join(temporary, file));
    return await buildPluginPackage(temporary, outputPath);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [endpoint, outputPath] = process.argv.slice(2);
  if (!endpoint || !outputPath) throw new Error("Usage: node prepare.mjs tcp://<private-fixture-ip>:3306 <output.ncpkg>");
  const result = await prepareDatabaseExample(endpoint, path.resolve(outputPath));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
