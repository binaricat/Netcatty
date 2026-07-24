const { rebuildPatchedNodePty } = require("./nodePtyConptyPatch.cjs");

rebuildPatchedNodePty({
  projectDir: process.cwd(),
  platform: process.platform,
  arch: process.env.npm_config_arch || process.arch,
});
