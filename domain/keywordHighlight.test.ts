import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_KEYWORD_HIGHLIGHT_RULES,
  KeywordHighlightRule,
  normalizeTerminalSettings,
} from "./models";

const IP_MAC_RULE = "ip-mac";

const ipMacDefault = () => {
  const def = DEFAULT_KEYWORD_HIGHLIGHT_RULES.find((r) => r.id === IP_MAC_RULE);
  if (!def) throw new Error("ip-mac default rule missing");
  return def;
};

const getRule = (
  rules: KeywordHighlightRule[],
  id: string,
): KeywordHighlightRule => {
  const rule = rules.find((r) => r.id === id);
  if (!rule) throw new Error(`rule ${id} missing`);
  return rule;
};

const matchesAny = (patterns: string[], input: string): boolean =>
  patterns.some((p) => new RegExp(p, "gi").test(input));

test("ip-mac built-in rule includes IPv6 patterns by default", () => {
  const def = ipMacDefault();
  // Compressed mid-form (issue #958 example #1)
  assert.ok(
    matchesAny(def.patterns, "2001:11:22:33::5"),
    "expected default ip-mac rule to match 2001:11:22:33::5",
  );
  // Link-local compressed (issue #958 example #2)
  assert.ok(
    matchesAny(def.patterns, "fe80::d2dd:bff:fe79:f2bb"),
    "expected default ip-mac rule to match fe80::d2dd:bff:fe79:f2bb",
  );
  // Loopback
  assert.ok(matchesAny(def.patterns, "::1"), "expected ::1 to match");
  // Full form
  assert.ok(
    matchesAny(def.patterns, "2001:0db8:85a3:0000:0000:8a2e:0370:7334"),
    "expected full-form IPv6 to match",
  );
});

test("ip-mac IPv6 regex still matches IPv4 and MAC", () => {
  const def = ipMacDefault();
  assert.ok(matchesAny(def.patterns, "10.0.0.1"), "expected IPv4 still matches");
  assert.ok(
    matchesAny(def.patterns, "aa:bb:cc:dd:ee:ff"),
    "expected MAC still matches",
  );
});

test("ip-mac IPv6 regex does not match obviously-not-IPv6 hex blobs", () => {
  const def = ipMacDefault();
  // A single hex word without colons must not match
  assert.ok(!matchesAny(def.patterns, "deadbeef"), "single hex word matched");
  // A typical sha-like string with colons separating fewer than two groups
  assert.ok(!matchesAny(def.patterns, "abc"), "stray hex matched");
});

test("normalize adds newly-shipped default rules to legacy saved sets", () => {
  // Simulate an older save that only has 'error' and an old-shape 'ip-mac'
  // (i.e. without IPv6). Because the rule is NOT marked customized, normalize
  // should re-sync it with the latest shipped patterns.
  const legacyIpMacPatterns = ["legacy-pattern-from-old-default"];
  const saved: KeywordHighlightRule[] = [
    {
      id: "error",
      label: "Error",
      patterns: ["\\berror\\b"],
      color: "#F87171",
      enabled: true,
    },
    {
      id: IP_MAC_RULE,
      label: "URL, IP & MAC",
      patterns: legacyIpMacPatterns,
      color: "#EC4899",
      enabled: true,
    },
  ];

  const settings = normalizeTerminalSettings({
    keywordHighlightRules: saved,
  });
  const rules = settings.keywordHighlightRules;

  // Every shipped default exists (warning/ok/info/debug get added).
  for (const def of DEFAULT_KEYWORD_HIGHLIGHT_RULES) {
    assert.ok(
      rules.some((r) => r.id === def.id),
      `expected normalize to include shipped rule ${def.id}`,
    );
  }

  // ip-mac was not customized → patterns re-sync to defaults, picking up IPv6.
  const ipMac = getRule(rules, IP_MAC_RULE);
  assert.deepEqual(ipMac.patterns, ipMacDefault().patterns);
  assert.ok(matchesAny(ipMac.patterns, "2001:11:22:33::5"));
});

test("normalize preserves user-edited patterns when rule.customized is set", () => {
  const customPatterns = ["\\bMY_CUSTOM\\b", "\\bANOTHER\\b"];
  const customLabel = "My Errors";
  const saved: KeywordHighlightRule[] = [
    {
      id: "error",
      label: customLabel,
      patterns: customPatterns,
      color: "#FF0000",
      enabled: false,
      customized: true,
    },
  ];

  const settings = normalizeTerminalSettings({
    keywordHighlightRules: saved,
  });
  const rule = getRule(settings.keywordHighlightRules, "error");

  assert.equal(rule.label, customLabel);
  assert.deepEqual(rule.patterns, customPatterns);
  assert.equal(rule.color, "#FF0000");
  assert.equal(rule.enabled, false);
  assert.equal(rule.customized, true);
});

test("normalize keeps custom (non-built-in) rules verbatim", () => {
  const customRule: KeywordHighlightRule = {
    id: "user-uuid-1",
    label: "Pager",
    patterns: ["\\b[A-Z]{3}-\\d+\\b"],
    color: "#00FF00",
    enabled: true,
  };

  const settings = normalizeTerminalSettings({
    keywordHighlightRules: [customRule],
  });

  const rule = getRule(settings.keywordHighlightRules, "user-uuid-1");
  assert.deepEqual(rule.patterns, customRule.patterns);
  assert.equal(rule.label, customRule.label);
});

test("Unix path highlighting covers terminal paths without matching relative prose or URL slashes", () => {
  const rule = getRule(DEFAULT_KEYWORD_HIGHLIGHT_RULES, "unix-path");
  for (const path of ["/sbin/iptables", "/var/log/syslog", "/usr/local/bin/g++", "~/projects/netcatty"]) {
    const matches = [...`'${path}'`.matchAll(new RegExp(rule.patterns[0], "gi"))];
    assert.deepEqual(matches.map((match) => match[0]), [path]);
  }
  for (const text of ["RELATED,ESTABLISHED", "TCP/IP", "https://example.com/log", " / ", "./foo", "../foo", "../../foo"]) {
    assert.equal(matchesAny(rule.patterns, text), false, text);
  }
});

test("Unix path rule upgrades old settings while preserving disabled highlights and edits", () => {
  const legacy = DEFAULT_KEYWORD_HIGHLIGHT_RULES.filter((rule) => rule.id !== "unix-path");
  const upgraded = normalizeTerminalSettings({ keywordHighlightEnabled: false, keywordHighlightRules: legacy });
  assert.equal(upgraded.keywordHighlightEnabled, false);
  assert.equal(getRule(upgraded.keywordHighlightRules, "unix-path").enabled, true);

  const edited = { ...getRule(upgraded.keywordHighlightRules, "unix-path"), color: "#123456", enabled: false, customized: true, patterns: ["/chosen/path"] };
  const restored = normalizeTerminalSettings({ keywordHighlightRules: [...legacy, edited] });
  assert.deepEqual(getRule(restored.keywordHighlightRules, "unix-path"), edited);
});

test("Unix path highlighting keeps Unicode paths and quoted spaces together", () => {
  const rule = getRule(DEFAULT_KEYWORD_HIGHLIGHT_RULES, "unix-path");
  for (const [text, path] of [
    ["/home/用户/file", "/home/用户/file"],
    ['cat "/Users/me/My Projects/app"', "/Users/me/My Projects/app"],
    ["cat '/home/用户/My Projects/app'", "/home/用户/My Projects/app"],
  ]) {
    const matches = [...text.matchAll(new RegExp(rule.patterns[0], "gi"))];
    assert.deepEqual(matches.map((match) => match[0]), [path]);
  }
});

test("Unix path highlighting keeps punctuation up to the text boundary", () => {
  const rule = getRule(DEFAULT_KEYWORD_HIGHLIGHT_RULES, "unix-path");
  for (const path of [
    "/run/user/1000/gvfs/smb-share:server=nas,share=files/report.txt",
    "/tmp/build=release/output",
  ]) {
    const matches = [...path.matchAll(new RegExp(rule.patterns[0], "gi"))];
    assert.deepEqual(matches.map((match) => match[0]), [path]);
  }
});
