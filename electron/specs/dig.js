// dig spec — corrects two upstream problems: the NS shortcut is labelled as an
// MX query, and "TTL" is offered as a record type even though TTL is a field.
const completionSpec = {
  name: "dig",
  description: "DNS lookup utility (Domain Information Groper)",
  subcommands: [
    { name: "A", description: "Query A records (IPv4 address)" },
    { name: "AAAA", description: "Query AAAA records (IPv6 address)" },
    { name: "MX", description: "Query MX records (mail exchangers)" },
    { name: "CNAME", description: "Query CNAME records (canonical name)" },
    { name: "TXT", description: "Query TXT records" },
    { name: "NS", description: "Query NS records (authoritative name servers)" },
    { name: "SOA", description: "Query the SOA record (start of authority)" },
    {
      name: "ANY",
      description: "Send an ANY query; the response may be incomplete (RFC 8482)",
    },
  ],
  options: [
    { name: "+short", description: "Only print meaningful results" },
    { name: "+noall", description: "Hide all sections except the ones requested explicitly" },
    { name: "+answer", description: "Show the answer section" },
    { name: "+nocomments", description: "Hide the comment lines" },
    { name: "+noquestion", description: "Hide the question section" },
    { name: "+noauthority", description: "Hide the authority section" },
    { name: "+noadditional", description: "Hide the additional section" },
    { name: "+nostats", description: "Hide the statistics block" },
  ],
};

export default completionSpec;
