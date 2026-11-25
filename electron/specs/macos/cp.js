// macOS BSD cp options and recursive copy semantics.
export default {
  name: "cp",
  description: "Copy files and directories",
  args: [
    { name: "source", template: ["filepaths", "folders"], isVariadic: true },
    { name: "target", template: ["filepaths", "folders"] },
  ],
  options: [
    { name: "-a", description: "Archive mode, equivalent to -RpP" },
    { name: "-f", description: "If the destination file cannot be opened, remove it and create a new file, without prompting for confirmation", exclusiveOn: ["-n"] },
    { name: "-H", description: "If the -R option is specified, symbolic links on the command line are followed", exclusiveOn: ["-L", "-P"], dependsOn: ["-R"] },
    { name: "-i", description: "Prompt before overwriting an existing file", exclusiveOn: ["-n"] },
    { name: "-L", description: "If the -R option is specified, all symbolic links are followed", exclusiveOn: ["-H", "-P"], dependsOn: ["-R"] },
    { name: "-n", description: "Do not overwrite an existing file", exclusiveOn: ["-f", "-i"] },
    { name: "-P", description: "If the -R option is specified, no symbolic links are followed", exclusiveOn: ["-H", "-L"], dependsOn: ["-R"] },
    { name: "-p", description: "Preserve file attributes such as permissions, ownership, and timestamps" },
    { name: "-R", description: "Copy directories recursively; a trailing slash on the source copies only its contents" },
    { name: "-r", description: "Copy directories recursively (legacy option; prefer -R for portability)" },
    { name: "-v", description: "Cause cp to be verbose, showing files as they are copied" },
    { name: "-X", description: "Do not copy Extended Attributes (EAs) or resource forks" },
    { name: "-c", description: "Copy files using clonefile" },
  ],
};
