"use strict";

const EXTERNAL_MCP_NAME = "netcatty-external";
const DISCOVERY_ENV_VAR = "NETCATTY_EXTERNAL_MCP_DISCOVERY_FILE";

function buildUniversalSetupPrompt({ launcherPath, discoveryPath, skillContent }) {
  if (typeof launcherPath !== "string" || !launcherPath.trim()) {
    throw new Error("Netcatty External MCP launcher path is unavailable.");
  }
  if (typeof discoveryPath !== "string" || !discoveryPath.trim()) {
    throw new Error("Netcatty External MCP discovery path is unavailable.");
  }
  if (typeof skillContent !== "string" || !skillContent.trim()) {
    throw new Error("Netcatty MCP skill content is unavailable.");
  }

  const serverEntry = {
    command: launcherPath,
    args: [],
    env: {
      [DISCOVERY_ENV_VAR]: discoveryPath,
    },
  };
  const configSnippet = JSON.stringify({
    mcpServers: {
      [EXTERNAL_MCP_NAME]: serverEntry,
    },
  }, null, 2);

  return `Install the Netcatty integration in the AI coding client you are currently running in.

Complete the installation directly when the client supports it. Inspect the local client version, CLI help, and existing configuration to determine its native MCP and Agent Skills conventions. Do not invent configuration paths or formats.

Requirements:

1. Add a user-level stdio MCP server named \`${EXTERNAL_MCP_NAME}\` using the exact values below. Merge it into the existing configuration and preserve every unrelated server and setting.
2. If an entry named \`${EXTERNAL_MCP_NAME}\` already exists and is clearly an older Netcatty entry, update it. If it points to an unrelated command, stop and report the conflict instead of overwriting it.
3. If the client supports Agent Skills, install the supplied skill as \`netcatty-mcp/SKILL.md\` in the client's native user-level skills directory. Preserve an existing same-name skill unless it contains \`managed-by: netcatty\`; Netcatty-managed copies may be updated.
4. If Agent Skills are unsupported, add the behavioral instructions from the supplied skill to the client's user-level persistent instructions. Keep existing instructions intact and use clearly marked Netcatty boundaries. If no user-level persistent instruction mechanism exists, configure MCP only and report that limitation.
5. Do not install dependencies, use network access, or modify project files just to complete this setup.
6. After writing the configuration, use the client's native MCP status/list command or configuration parser to validate it. If the current process can reload MCP servers, call \`get_environment\` on \`${EXTERNAL_MCP_NAME}\`. Otherwise explain that a new client session is required and give the exact verification command or action.
7. Report the MCP configuration path, Skill or persistent-instruction path, validation result, and any required restart. Never claim success without checking the files you wrote.

MCP configuration to adapt to the client's native format:

\`\`\`json
${configSnippet}
\`\`\`

Exact Skill content:

\`\`\`markdown
${skillContent.trim()}
\`\`\`
`;
}

module.exports = {
  EXTERNAL_MCP_NAME,
  DISCOVERY_ENV_VAR,
  buildUniversalSetupPrompt,
};
