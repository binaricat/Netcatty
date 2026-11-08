// readlink spec - GNU coreutils. The bundled Fig spec reuses stat wording for
// the command root and -f, so this local spec describes the real GNU options.
const completionSpec = {
  name: "readlink",
  description: "Print resolved symbolic links or canonical file names",
  options: [
    {
      name: ["-f", "--canonicalize"],
      description: "Resolve every symbolic link in the given path and print the canonical path (all but the last component must exist)",
    },
    {
      name: ["-e", "--canonicalize-existing"],
      description: "Resolve symbolic links and print the canonical path only if all components exist",
    },
    {
      name: ["-m", "--canonicalize-missing"],
      description: "Resolve symbolic links and print the canonical path even if components are missing",
    },
    { name: ["-n", "--no-newline"], description: "Do not print a trailing newline" },
    { name: ["-q", "--quiet", "-s", "--silent"], description: "Suppress most error messages" },
    { name: ["-v", "--verbose"], description: "Report error messages" },
    { name: ["-z", "--zero"], description: "End each output path with NUL instead of a newline" },
    { name: "--help", description: "Display help text" },
    { name: "--version", description: "Display version information" },
  ],
  args: { name: "file", description: "Symbolic link or path to resolve", isVariadic: true },
};

export default completionSpec;
