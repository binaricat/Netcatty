// ip spec — iproute2 networking configuration.
//
// @withfig/autocomplete has no ip/netstat/ss specs, so the completion popup
// has no subcommand or option data for them. This local spec covers the
// common iproute2 objects and actions; descriptions are translated by the
// zh-CN/zh-TW autocomplete overlay like every other spec.
const action = (name, description) => ({ name, description });

const addressActions = [
  action("show", "Display addresses"),
  action("add", "Add a new address"),
  action("del", "Delete an address"),
  action("change", "Change an address"),
  action("replace", "Add a new address or change an existing one"),
  action("flush", "Flush addresses"),
  action("save", "Save address configuration"),
  action("restore", "Restore address configuration"),
];

const linkActions = [
  action("show", "Display network devices"),
  action("add", "Add a new network device"),
  action("del", "Delete a network device"),
  action("set", "Change device attributes"),
  action("change", "Change device attributes"),
  action("replace", "Add a new device or change an existing one"),
  action("up", "Enable a network device"),
  action("down", "Disable a network device"),
  action("save", "Save device configuration"),
  action("restore", "Restore device configuration"),
];

const routeActions = [
  action("show", "Display routes"),
  action("add", "Add a new route"),
  action("del", "Delete a route"),
  action("change", "Change a route"),
  action("replace", "Add a new route or change an existing one"),
  action("append", "Append a new route"),
  action("prepend", "Prepend a new route"),
  action("flush", "Flush routes"),
  action("get", "Get a single route"),
];

const neighborActions = [
  action("show", "Display neighbor entries"),
  action("add", "Add a new neighbor entry"),
  action("del", "Delete a neighbor entry"),
  action("change", "Change a neighbor entry"),
  action("replace", "Add a new entry or change an existing one"),
  action("flush", "Flush neighbor entries"),
];

const ruleActions = [
  action("show", "Display routing policy rules"),
  action("add", "Add a new rule"),
  action("del", "Delete a rule"),
  action("flush", "Flush rules"),
];

const tunnelActions = [
  action("show", "Display tunnels"),
  action("add", "Add a new tunnel"),
  action("del", "Delete a tunnel"),
  action("change", "Change a tunnel"),
  action("replace", "Add a new tunnel or change an existing one"),
  action("flush", "Flush tunnels"),
];

const netnsActions = [
  action("list", "List network namespaces"),
  action("add", "Add a new network namespace"),
  action("del", "Delete a network namespace"),
  action("identify", "Identify a network namespace"),
  action("pids", "List processes in a network namespace"),
  action("exec", "Run a command in a network namespace"),
  action("monitor", "Monitor network namespace changes"),
];

const maddressActions = [
  action("show", "Display multicast addresses"),
  action("add", "Add a multicast address"),
  action("del", "Delete a multicast address"),
  action("flush", "Flush multicast addresses"),
];

const mrouteActions = [
  action("show", "Display multicast routes"),
  action("add", "Add a multicast route"),
  action("del", "Delete a multicast route"),
  action("flush", "Flush multicast routes"),
];

const completionSpec = {
  name: "ip",
  description: "Show / manipulate routing, network devices, interfaces and tunnels",
  options: [
    { name: ["-V", "-Version"], description: "Print the version and exit" },
    { name: ["-h", "-human"], description: "Output statistics with human-readable values" },
    { name: ["-s", "-stats", "-statistics"], description: "Output more information" },
    { name: ["-d", "-details"], description: "Output more detailed information" },
    { name: ["-r", "-resolve"], description: "Resolve host names" },
    { name: ["-4"], description: "Use IPv4" },
    { name: ["-6"], description: "Use IPv6" },
    { name: ["-br", "-brief"], description: "Print human-readable output" },
    { name: ["-j", "-json"], description: "Output JSON" },
    { name: ["-p", "-pretty"], description: "Pretty-print JSON output" },
    { name: ["-c", "-color"], description: "Use color output" },
    { name: ["-o", "-oneline"], description: "Output each record on a single line" },
    {
      name: ["-n", "-netns"],
      description: "Switch to a network namespace",
      args: { name: "NETNS" },
    },
    {
      name: ["-N", "-Numeric"],
      description: "Print the raw priority, protocol and scope values",
    },
    {
      name: ["-f", "-family"],
      description: "Specify the protocol family",
      args: { name: "FAMILY", suggestions: ["inet", "inet6", "bridge", "link", "mpls"] },
    },
  ],
  subcommands: [
    { name: ["address", "a", "addr"], description: "Manage addresses", subcommands: addressActions },
    { name: ["link", "l"], description: "Manage network devices", subcommands: linkActions },
    { name: ["route", "r", "ro"], description: "Manage the routing table", subcommands: routeActions },
    {
      name: ["neighbor", "n", "neigh"],
      description: "Manage the neighbor table",
      subcommands: neighborActions,
    },
    { name: ["rule", "ru"], description: "Manage routing policy rules", subcommands: ruleActions },
    { name: ["tunnel", "tun"], description: "Manage tunnels", subcommands: tunnelActions },
    { name: ["netns"], description: "Manage network namespaces", subcommands: netnsActions },
    {
      name: ["maddress", "maddr"],
      description: "Manage multicast addresses",
      subcommands: maddressActions,
    },
    {
      name: ["mroute", "mr"],
      description: "Manage the multicast routing table",
      subcommands: mrouteActions,
    },
    {
      name: ["xfrm"],
      description: "Manage IPsec policies and states",
      subcommands: [
        action("state", "Manage IPsec states"),
        action("policy", "Manage IPsec policies"),
        action("monitor", "Monitor IPsec events"),
      ],
    },
    { name: ["monitor"], description: "Watch for netlink messages" },
    { name: ["help"], description: "Show help" },
  ],
};

export default completionSpec;
