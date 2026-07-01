import test from "node:test";
import assert from "node:assert/strict";

import type { Host, KeywordHighlightRule } from "../../types.ts";
import { addHostKeywordHighlightRule } from "./HostKeywordHighlightPopover.tsx";

const baseHost: Host = {
  id: "host-1",
  label: "Production",
  hostname: "prod.example.com",
  username: "root",
  tags: [],
  os: "linux",
  keywordHighlightEnabled: false,
  keywordHighlightRules: [
    {
      id: "old-rule",
      label: "Old rule",
      patterns: ["OLD"],
      color: "#FBBF24",
      enabled: true,
    },
  ],
};

const newRule: KeywordHighlightRule = {
  id: "new-rule",
  label: "Deploy",
  patterns: ["DEPLOY"],
  color: "#F87171",
  enabled: true,
};

test("adding a host keyword highlight rule enables host highlighting", () => {
  const updated = addHostKeywordHighlightRule(baseHost, newRule);

  assert.equal(updated.keywordHighlightEnabled, true);
  assert.deepEqual(updated.keywordHighlightRules, [
    ...(baseHost.keywordHighlightRules ?? []),
    newRule,
  ]);
});
