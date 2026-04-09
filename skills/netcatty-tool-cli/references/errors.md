# Error Handling

Read this when a Netcatty CLI call fails or returns a blocked state.

## Rules

- Treat Netcatty CLI errors as authoritative. Do not argue with them or try alternate launch methods.
- If Netcatty returns `COMMAND_ALREADY_RUNNING`, wait for the in-flight command to finish instead of retrying in parallel.
- Netcatty enforces scope, approvals, blocklists, and timeouts. Do not try to bypass those checks with wrappers or alternate shells.
- If a direct command fails and the failure suggests the task genuinely needs branching or parsing logic, then consider a small script. Otherwise keep commands simple.
