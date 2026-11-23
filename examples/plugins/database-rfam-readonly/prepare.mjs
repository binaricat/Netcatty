import fs from "node:fs/promises";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPluginPackage } from "@netcatty/plugin-cli";
import { build } from "esbuild";

export const RFAM_ENDPOINT = "tcp://mysql-rfam-public.ebi.ac.uk:4497";
const root = path.dirname(fileURLToPath(import.meta.url));

export async function prepareRfamExample(targetEndpoint, outputPath) {
  // This separate sample accepts one documented hostname. It does not change
  // the private-fixture preparer, host endpoint policy, or runtime permissions.
  if (targetEndpoint !== RFAM_ENDPOINT) throw new Error("Use only the documented exact Rfam sample endpoint");
  const temporary = await fs.mkdtemp(path.join(path.dirname(outputPath), ".rfam-example-"));
  try {
    for (const file of ["netcatty.plugin.json"]) {
      await fs.copyFile(path.join(root, file), path.join(temporary, file));
    }
    const bundle = await build({ entryPoints: [path.join(root, "host.js")], write: false,
      loader: { ".html": "text", ".css": "text" }, bundle: true, minify: true, platform: "browser", format: "esm", nodePaths: [path.resolve(root, "../../../node_modules")] });
    await fs.writeFile(path.join(temporary, "browser.js"), bundle.outputFiles[0].contents);
    return await buildPluginPackage(temporary, outputPath);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [endpoint, outputPath] = process.argv.slice(2);
  if (!endpoint || !outputPath) throw new Error("Usage: node prepare.mjs tcp://mysql-rfam-public.ebi.ac.uk:4497 <output.ncpkg>");
  process.stdout.write(`${JSON.stringify(await prepareRfamExample(endpoint, path.resolve(outputPath)))}\n`);
}
