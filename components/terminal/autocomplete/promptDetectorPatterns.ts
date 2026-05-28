/**
 * Patterns that indicate the user is NOT at a prompt
 * (e.g., inside vim, less, man, top, etc.)
 */
export const NON_PROMPT_PATTERNS = [
  /^~$/,                         // vim empty line marker
  /^\s*--\s*More\s*--/,          // less/more pager
  /^\s*\(END\)/,                 // less end marker
  /^:\s*$/,                      // vim command mode
  /^\s*~\s*$/,                   // vim tilde lines
  /^>{1,3}\s/,                   // Bare > (bash PS2 continuation), >> or >>> (python REPL)
  /^\s{4}(?:->|['"`]>)\s/,       // mysql / mariadb continuation prompts
  /^(?:mysql|sqlite(?:3)?|redis(?:-cli)?|psql|mariadb)>\s/i, // mysql> / sqlite> / redis-cli> prompts
  /^SQL>\s/i,                      // sqlplus SQL> prompts
  /^(?:sftp|ftp|lftp|ghci|node|mongo|mongosh|deno|irb|pry|julia|scala|gdb|lldb|cqlsh|hive|spark-sql|jshell|ksql|trino|presto|duckdb)>\s/i,
  /^irb\([^)]*\):\d+[:*]?\d*>\s/i,
  /^pry\([^)]*\)>\s/i,
  /^\[\d+\]\s+pry\([^)]*\)>\s/i,
  /^lftp\s+\S+>\s/i,
  /^\s{3}\.{3}>\s/,
  /^cqlsh(?::[\w.-]+)?>\s/i,
  /^(?:hive|spark-sql)\s+\([^)]+\)>\s/i,
  /^(?:\d+:\s*)?jdbc:hive2?:\/\/\S+>\s/i,
  /^(?:test|admin|local|config)>\s+(?:db(?:\.|\s*$)|rs\.|print\s*\(|(?:const|let|var|await)\b|\d+\s*[-+*/]\s*\d*)/i,
  /^[\w.-]+:[A-Z]+>\s+(?:db\.|rs\.|exit\b|(?:const|let|var|await)\b|show\s+(?:dbs?|collections|users|roles)|use\s+\w+|it\b)/i,
  /^(?:[\w.-]+\s+){0,5}\[[^\]]+\]\s+[\w.-]+>\s+(?:db\.|rs\.|exit\b|hel(?:p)?\b|print\s*\(|(?:const|let|var|await)\b|\d+\s*[-+*/]\s*\d*|show\s+(?:dbs?|collections|users|roles)|use\s+\w+|it\b)/i,
  /^(?:[\w.-]+\s+){1,5}[\w.-]+>\s+(?:db\.|rs\.|exit\b|hel(?:p)?\b|print\s*\(|(?:const|let|var|await)\b|\d+\s*[-+*/]\s*\d*|show\s+(?:dbs?|collections|users|roles)|use\s+\w+|it\b)/i,
  /^(?:trino|presto)(?::[\w.-]+){1,2}>\s/i,
  /^[\w.-]+@(?:[\w.-]+|\d{1,3}(?:\.\d{1,3}){3}):\d+>\s/i,
  /^(?:[\w.-]+|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)(?:\[\d+\])?>\s/, // redis host:port> prompts
  /^MariaDB\s+\[[^\]]+\]>\s/i,   // MariaDB [(none)]> prompts
  /^[\w.-]+=[#>]\s/,             // postgres=# / postgres=> REPL prompts
  /^[\w.-]+[-'"][#>]\s/,         // postgres-# / postgres'# continuation prompts
  /^[\w.-]+(?:\([^)]*|\*|!|\^|\$[^$]*\$)[#>]\s/, // postgres multiline prompt states
];

export const COMMON_SHELL_COMMANDS = new Set([
  "alias",
  "awk",
  "az",
  "brew",
  "bun",
  "bundle",
  "cargo",
  "cat",
  "cd",
  "chmod",
  "chown",
  "code",
  "composer",
  "cp",
  "curl",
  "docker",
  "echo",
  "emacs",
  "env",
  "export",
  "find",
  "gcloud",
  "gh",
  "git",
  "go",
  "gradle",
  "grep",
  "helm",
  "java",
  "javac",
  "kubectl",
  "less",
  "ls",
  "make",
  "mkdir",
  "mvn",
  "mv",
  "nano",
  "node",
  "npm",
  "npx",
  "nvim",
  "php",
  "pip",
  "pip3",
  "pnpm",
  "printf",
  "python",
  "python3",
  "rails",
  "rm",
  "rsync",
  "ruby",
  "rustc",
  "scp",
  "screen",
  "sed",
  "ssh",
  "sudo",
  "tail",
  "tar",
  "terraform",
  "tmux",
  "touch",
  "uv",
  "vi",
  "vim",
  "yarn",
]);

/** Characters that commonly end a shell prompt */
export const PROMPT_CHARS = new Set(["$", "#", "%", ">", "❯", "❮", "→", "➜", "➤", "⟩", "»", "›"]);
