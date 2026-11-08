// macOS readlink follows BSD options, not GNU's -e/-m/-s/-v flags.
const completionSpec = {
  name: "readlink",
  description: "Print resolved symbolic links or canonical file names",
  options: [
    {
      name: "-f",
      description: "Resolve symbolic links and print the canonical path only if all components exist",
    },
    { name: "-n", description: "Do not print a trailing newline" },
  ],
  args: { name: "file", description: "Symbolic link or path to resolve", isVariadic: true, template: "filepaths" },
};

export default completionSpec;
