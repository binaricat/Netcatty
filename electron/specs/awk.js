// awk spec — pattern scanning and text processing language
const completionSpec = {
  name: "awk",
  description: "Pattern scanning and text processing language",
  args: [
    { name: "program", description: "AWK program text (e.g. '{print $1}')" },
    { name: "file", description: "Input file(s)", isOptional: true, isVariadic: true, template: "filepaths" },
  ],
  options: [
    { name: "-F", description: "Set field separator", args: { name: "separator", description: "e.g. ',' or '\\t'" } },
    { name: "-v", description: "Assign a variable (var=value)", args: { name: "var=value" } },
    { name: "-f", description: "Read AWK program from file", args: { name: "progfile", template: "filepaths" } },
    { name: "-o", description: "Enable pretty-printed output", args: { name: "file", isOptional: true, template: "filepaths" } },
    { name: "-b", description: "Treat all input data as single-byte characters (gawk)" },
    { name: "-c", description: "Run in POSIX compatibility mode (gawk)" },
    { name: "-C", description: "Print copyright information" },
    { name: "-d", description: "Dump variables to file (gawk)", args: { name: "file", isOptional: true, template: "filepaths" } },
    { name: "-e", description: "Specify AWK program text", args: { name: "program" } },
    { name: "-E", description: "Read AWK program from file (like -f but disables command-line variable assignments)", args: { name: "file", template: "filepaths" } },
    { name: "-i", description: "Include AWK source library", args: { name: "source-file", template: "filepaths" } },
    { name: "-l", description: "Load dynamic extension (gawk)", args: { name: "ext" } },
    { name: "-n", description: "Disable automatic input record splitting (gawk)" },
    { name: "-N", description: "Use locale decimal point for parsing input data (gawk)" },
    { name: "-p", description: "Profile execution and write to file (gawk)", args: { name: "file", isOptional: true, template: "filepaths" } },
    { name: "-P", description: "POSIX compatibility mode (gawk)" },
    { name: "-S", description: "Sandbox mode — disable system(), I/O redirection (gawk)" },
    { name: "-t", description: "Enable type checking (gawk)" },
    { name: "--help", description: "Show help" },
    { name: "--version", description: "Print version information" },
  ],
};

export default completionSpec;
