// htop spec — the bundled Fig spec says the -H delay is in tenths of a second,
// but htop stores it in seconds (Settings.c clamps highlightDelaySecs and
// ProcessList.c compares 1000 * highlightDelaySecs). Only that wording differs.
const completionSpec = {
  name: "htop",
  description: "Improved top (interactive process viewer)",
  options: [
    { name: ["--help", "-h"], description: "Show help for htop" },
    { name: ["--no-color", "-C"], description: "Use a monochrome color scheme" },
    {
      name: ["--delay", "-d"],
      description: "Delay between updates, in tenths of sec",
      args: { name: "delay", suggestions: ["10", "1", "60"] },
    },
    { name: ["--filter", "-F"], description: "Filter commands", args: { name: "filter" } },
    {
      name: ["--highlight-changes", "-H"],
      description: "Highlight new and old processes",
      args: {
        name: "delay",
        description: "Highlight duration in seconds",
        isOptional: true,
        suggestions: ["1", "10", "60"],
      },
    },
    { name: ["--no-mouse", "-M"], description: "Disable the mouse" },
    { name: ["--pid", "-p"], description: "Show only the given PIDs", args: { name: "PID", isVariadic: true } },
    { name: ["--sort-key", "-s"], description: "Sort by the given column", args: { name: "column" } },
    { name: ["--tree", "-t"], description: "Show the tree view" },
    { name: ["--user", "-u"], description: "Show only processes of the given user", args: { name: "user", isOptional: true, suggestions: ["$USER"] } },
    { name: ["--no-unicode", "-U"], description: "Do not use unicode but plain ASCII" },
    { name: ["--version", "-V"], description: "Print version info" },
  ],
};

export default completionSpec;
