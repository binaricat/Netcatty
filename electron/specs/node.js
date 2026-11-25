// node spec override.
//
// The bundled @withfig/autocomplete build gives --preserve-symlinks the
// description for Django's --symlinks ("Follows symlinks to directories when
// examining source code and templates for translation strings"). Node's flag
// controls module resolution instead, so patch the bundled spec here (instead
// of copying every Node option) and let the zh-CN/zh-TW overlay translate the
// corrected description.
//
// The package does not export build/node.js, so resolve the installed build
// with the same electron/../node_modules path the main loader uses in dev and
// inside app.asar.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const bundled = require("../../node_modules/@withfig/autocomplete/build/node.js");
const completionSpec = bundled.default?.default ?? bundled.default;

const preserveSymlinks = completionSpec.options?.find((option) => {
  const names = Array.isArray(option.name) ? option.name : [option.name];
  return names.includes("--preserve-symlinks");
});
if (preserveSymlinks) {
  preserveSymlinks.description = "Preserve symbolic links when resolving and caching modules";
}

export default completionSpec;
