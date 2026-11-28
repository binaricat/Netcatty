import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validatePluginStylesheet, MAX_CSS_LENGTH } = require('../../../domain/pluginViewStylePolicy.cjs');

const css = await readFile('src/style.css', 'utf8');
if (Buffer.byteLength(css, 'utf8') > MAX_CSS_LENGTH) {
  throw new Error(`src/style.css exceeds MAX_CSS_LENGTH (${MAX_CSS_LENGTH} bytes)`);
}
validatePluginStylesheet(css);
console.log(`Netcatty host stylesheet policy passed (${Buffer.byteLength(css, 'utf8')} bytes)`);
