// date spec - GNU coreutils date (Linux hosts). The bundled Fig spec follows
// BSD/macOS flags (-j, -n, -t, -v) that GNU date does not have, so this local
// spec describes the GNU option set instead. Local specs win over the bundled
// package at runtime and in the translation audit.
const completionSpec = {
  name: "date",
  description: "Display or set date and time",
  options: [
    {
      name: ["-d", "--date"],
      description: "Display the date and time described by the given string instead of the current time",
      args: { name: "string", description: "Date string, for example '2024-01-01 12:00:00' or 'next friday'" },
    },
    {
      name: "--debug",
      description: "Annotate the parsed date and warn about questionable usage on standard error",
    },
    {
      name: ["-f", "--file"],
      description: "Parse each line of the given file like --date",
      args: { name: "datefile", description: "File with one date string per line", template: "filepaths" },
    },
    {
      name: ["-I", "--iso-8601"],
      netcattyOptionalArgAttached: true,
      description: "Output an ISO 8601 date/time string; the optional format is date, hours, minutes, seconds or ns",
      args: { name: "format", isOptional: true, suggestions: ["date", "hours", "minutes", "seconds", "ns"] },
    },
    {
      name: ["-R", "--rfc-email"],
      description: "Output an RFC 5322 email-style date and time string",
    },
    {
      name: "--rfc-3339",
      description: "Output an RFC 3339 date/time string in the given format",
      args: { name: "format", suggestions: ["date", "seconds", "ns"] },
    },
    {
      name: ["-r", "--reference"],
      description: "Display the last modification time of the given file",
      args: { name: "file", description: "File whose modification time is displayed", template: "filepaths" },
    },
    {
      name: ["-s", "--set"],
      description: "Set the system time from the given string",
      args: { name: "string", description: "Date string to set the system clock to" },
    },
    {
      name: ["-u", "--utc", "--universal"],
      description: "Display or set the date in UTC (Coordinated Universal) time",
    },
    { name: "--help", description: "Display help text" },
    { name: "--version", description: "Display version information" },
  ],
  args: {
    name: "+FORMAT",
    description: "Output format beginning with '+', using strftime escapes such as +%Y-%m-%d",
    isOptional: true,
  },
};

export default completionSpec;
