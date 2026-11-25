// GNU coreutils cp. macOS has a separate BSD spec.
export default {
  name: "cp",
  description: "Copy files and directories",
  args: [
    { name: "source", template: ["filepaths", "folders"], isVariadic: true },
    { name: "target", template: ["filepaths", "folders"] },
  ],
  options: [
    { name: ["-a", "--archive"], description: "Archive mode: copy recursively and preserve all attributes and links" },
    { name: ["-f", "--force"], description: "If the destination cannot be opened, remove it and retry the copy" },
    { name: "-H", description: "Follow only symbolic links given as source arguments", exclusiveOn: ["-L", "--dereference", "-P", "--no-dereference"] },
    { name: ["-i", "--interactive"], description: "Prompt before overwriting an existing file" },
    { name: ["-L", "--dereference"], description: "Follow all symbolic links in the source", exclusiveOn: ["-H", "-P", "--no-dereference"] },
    { name: ["-n", "--no-clobber"], description: "Do not overwrite an existing file" },
    { name: ["-P", "--no-dereference"], description: "Copy source symbolic links without following them", exclusiveOn: ["-H", "-L", "--dereference"] },
    { name: "-p", description: "Preserve permissions, ownership, and timestamps" },
    { name: ["-r", "-R", "--recursive"], description: "Copy directories recursively" },
    { name: ["-v", "--verbose"], description: "Cause cp to be verbose, showing files as they are copied" },
    { name: ["-x", "--one-file-system"], description: "Do not cross file system boundaries" },
    { name: "--help", description: "Display help text" },
    { name: "--version", description: "Display version information" },
  ],
};
