// htop spec. The bundled Fig spec gives the -H delay the wrong unit ("tenths
// of sec"). htop 3.2.2 parses it as highlightDelaySecs and compares it as
// 1000 * highlightDelaySecs, so the value is seconds. Every other description
// and argument matches the bundled spec.
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
        suggestions: ["10", "1", "60"],
        isOptional: true,
      },
    },
    { name: ["--no-mouse", "-M"], description: "Disable the mouse" },
    { name: ["--pid", "-p"], description: "Show only the given PIDs", args: { name: "PID", isVariadic: true } },
    { name: ["--sort-key", "-s"], description: "Sort by COLUMN in list view", args: { name: "column" } },
    { name: ["--tree", "-t"], description: "Show the tree view" },
    { name: ["--user", "-u"], description: "Show only processes for a given user (or $USER)", args: { name: "user", isOptional: true, suggestions: ["$USER"] } },
    { name: ["--no-unicode", "-U"], description: "Do not use unicode but plain ASCII" },
    { name: ["--version", "-V"], description: "Print version info" },
  ],
};

export default completionSpec;
