// macOS date uses BSD options. In current macOS releases, the old -d/-t
// timezone switches are no longer available; time zones are handled by tzdata.
const completionSpec = {
  name: "date",
  description: "Display or set date and time",
  options: [
    {
      name: "-f",
      description: "Use specified format for input instead of the default [[[mm]dd]HH]MM[[cc]yy][.ss] format",
      args: [
        { name: "input_fmt", description: "The format with which to parse the new date value" },
        { name: "new_date", description: "The new date to set" },
      ],
    },
    {
      name: "-I",
      netcattyOptionalArgAttached: true,
      description: "Output an ISO 8601 date/time string; the optional format is date, hours, minutes, seconds or ns",
      args: { name: "format", isOptional: true, suggestions: ["date", "hours", "minutes", "seconds", "ns"] },
    },
    { name: "-j", description: "Don't try to set the date" },
    { name: "-n", description: "Obsolete option, accepted and ignored for compatibility" },
    { name: "-R", description: "Use RFC 2822 date and time output format" },
    {
      name: "-r",
      description: "Display a file's modification time or a time expressed in seconds since the Epoch",
      // Keep path completion for numeric prefixes: filenames can start with digits.
      args: { name: "file or seconds", template: "filepaths" },
    },
    { name: "-u", description: "Display or set the date in UTC (Coordinated Universal) time" },
    {
      name: "-z",
      description: "Display the time in the specified output time zone",
      args: { name: "output_zone" },
    },
    {
      name: "-v",
      description: "Adjust and print (but don't set) the second, minute, hour, month day, week day, month, or year according to val",
      args: { name: "val", description: "[+|-]val[ymwdHMS]" },
    },
  ],
  args: {
    name: "new_time OR output_fmt",
    description: "New_time: [[[mm]dd]HH]MM[[cc]yy][.ss], output_fmt: '+' followed by user-defined format string",
    isOptional: true,
  },
};

export default completionSpec;
