import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectPluginBrandIcon } from '@netcatty/plugin-contract';

function assertSafeSvg(svg, label) {
  if (
    /<(?:script|image|foreignObject|use|style)\b|(?:href|on\w+)\s*=|url\(/i.test(
      svg.replace(/url\(#[a-zA-Z0-9_-]+\)/g, 'local-gradient'),
    )
  ) {
    throw new Error(`Unsafe plugin SVG: ${label}`);
  }
}

for (const theme of ['light', 'dark']) {
  const svgPath = `assets/plugin-icon-${theme}.svg`;
  const pngPath = `assets/plugin-icon-${theme}.png`;
  const svg = await readFile(svgPath, 'utf8');
  assertSafeSvg(svg, svgPath);
  const png = await readFile(pngPath);
  const { width, height } = inspectPluginBrandIcon(png, pngPath);
  if (width !== 256 || height !== 256) {
    throw new Error(`Unexpected plugin brand icon size (${width}x${height}): ${pngPath}`);
  }
}

const uiDir = 'assets/ui';
const uiEntries = (await readdir(uiDir)).filter((f) => f.endsWith('.svg')).sort();
if (uiEntries.length < 6) {
  throw new Error(`Expected >= 6 UI icons in ${uiDir}, found ${uiEntries.length}`);
}
for (const file of uiEntries) {
  const full = path.join(uiDir, file);
  const svg = await readFile(full, 'utf8');
  assertSafeSvg(svg, full);
}

console.log(
  `Validated 2 custom Netcatty Monitor brand icons (256x256 PNG+SVG) + ${uiEntries.length} UI icons (${uiDir})`,
);
