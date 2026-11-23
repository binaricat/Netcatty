// git spec override.
//
// The bundled @withfig/autocomplete build leaves git blame without a
// description — it is the only git subcommand in the build that has none — so
// the completion popup shows a blank row for it. Patch the bundled spec here
// (instead of copying 1,500 descriptions) so the zh-CN/zh-TW overlay can
// translate the description like every other subcommand.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const bundled = require("../../node_modules/@withfig/autocomplete/build/git.js");
const completionSpec = bundled.default?.default ?? bundled.default;

const blame = completionSpec.subcommands?.find((subcommand) => subcommand.name === "blame");
if (blame && !blame.description) {
  blame.description = "Show what revision and author last modified each line of a file";
}

export default completionSpec;
