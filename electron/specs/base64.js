// base64 spec — GNU coreutils. The bundled Fig spec follows BSD flags
// (-b line length, -i input file, -o output file); GNU uses -w, -i for
// ignoring invalid bytes while decoding, and positional files.
const completionSpec = {
  name: "base64",
  description: "Encode and decode using Base64 representation",
  options: [
    { name: ["-d", "--decode"], description: "Decode input instead of encoding it" },
    {
      name: ["-i", "--ignore-garbage"],
      description: "When decoding, ignore non-alphabet characters",
    },
    {
      name: ["-w", "--wrap"],
      description: "Wrap encoded lines after the given number of characters (0 disables wrapping)",
      args: { name: "cols", description: "Characters per line; 0 disables wrapping" },
    },
    { name: "--help", description: "Display help text" },
    { name: "--version", description: "Display version information" },
  ],
  args: { name: "file", description: "File to read; standard input when omitted or '-'", isOptional: true, isVariadic: true },
};

export default completionSpec;
