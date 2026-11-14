// dig spec. The bundled spec labels the NS shortcut as "Query MX Record" and
// offers "TTL" as a record type, but TTL is a record field. The English keys
// for A/MX/CNAME/TXT/SOA, ANY and the section filter stay byte-identical to
// the bundled spec because dog shares them; the ANY and filter caveats live in
// the zh-CN values instead of new English keys.
const shortOption = {
  name: ["+short", ""],
  insertValue: "+short {cursor}",
  description: "Only print meaningful results",
  args: {},
};

const record = (name, description) => ({
  name,
  description,
  options: [shortOption],
});

const completionSpec = {
  name: "dig",
  description: "Domain Information Groper",
  subcommands: [
    record("A", "Query Domain A Record"),
    record("MX", "Query Domain MX Record"),
    record("CNAME", "Query Domain CNAME Record"),
    record("TXT", "Query Domain TXT Record"),
    record("NS", "Query NS records (authoritative name servers)"),
    record("SOA", "Query SOA Record"),
    { name: "ANY +noall +answer", description: "Query ALL DNS Records" },
    {
      name: "+nocomments +noquestion +noauthority +noadditional +nostats",
      description: "Query only answer section",
    },
  ],
};

export default completionSpec;
