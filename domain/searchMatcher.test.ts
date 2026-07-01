import assert from "node:assert/strict";
import test from "node:test";

import {
  getHostSearchMatch,
  matchesHostSearchQuery,
  matchesSearchQuery,
} from "../lib/searchMatcher.ts";

test("matches mixed Chinese and dash-separated numeric suffix with spaced query", () => {
  assert.equal(
    matchesSearchQuery("山东 6-1", "山东-业务交换机6-1"),
    true,
  );
});

test("matches mixed Chinese and em-dash separator with spaced query", () => {
  assert.equal(
    matchesSearchQuery("山东 6-1", "山东—业务交换机6—1"),
    true,
  );
});

test("matches IPv4-like query only on contiguous dotted address", () => {
  assert.equal(
    matchesSearchQuery("192.168.6.1", "192.168.6.1"),
    true,
  );
  assert.equal(
    matchesSearchQuery("192.168.6.1", "192.168.16.10"),
    false,
  );
});

test("matches compact form across separators", () => {
  assert.equal(
    matchesSearchQuery("prod api 01", "prod-api-01"),
    true,
  );
});

test("host search does not mix human tokens with hostname IP tokens", () => {
  assert.equal(
    matchesHostSearchQuery("山东 6-1", {
      label: "山东-业务交换机2-2",
      hostname: "10.6.1.88",
      group: "铁塔网络设备/山东",
      tags: [],
    }),
    false,
  );
});

test("host search treats equivalent dash separators as strict punctuation matches", () => {
  const match = getHostSearchMatch("山东 6-1", {
    label: "山东—业务交换机6—1",
    hostname: "10.6.1.88",
    group: "铁塔/山东",
    tags: [],
  });

  assert.equal(match.matched, true);
  assert.equal(match.phase, "strict");
});

test("host search still supports direct IP matching", () => {
  assert.equal(
    matchesHostSearchQuery("10.6.1.88", {
      label: "山东-业务交换机2-2",
      hostname: "10.6.1.88",
      group: "铁塔网络设备/山东",
      tags: [],
    }),
    true,
  );
});

test("host search keeps trailing dash semantic and avoids loose numeric fallback", () => {
  assert.equal(
    matchesHostSearchQuery("山东 6-", {
      label: "山东-IPMI交换机6",
      hostname: "10.6.1.88",
      group: "铁塔/山东",
      tags: [],
    }),
    false,
  );
  assert.equal(
    matchesHostSearchQuery("山东 6-", {
      label: "山东-管理交换机6-1",
      hostname: "10.6.1.81",
      group: "铁塔/山东",
      tags: [],
    }),
    true,
  );
});

test("host search scoring prefers strict punctuation match over loose compact match", () => {
  const strict = getHostSearchMatch("山东 6-", {
    label: "山东-管理交换机6-1",
    hostname: "10.6.1.81",
    group: "铁塔/山东",
    tags: [],
  });
  const loose = getHostSearchMatch("山东 61", {
    label: "山东-管理交换机6-1",
    hostname: "10.6.1.81",
    group: "铁塔/山东",
    tags: [],
  });
  assert.equal(strict.matched, true);
  assert.equal(loose.matched, true);
  assert.equal(strict.phase, "strict");
  assert.equal(loose.phase, "loose");
  assert.equal(strict.score > loose.score, true);
});

test("punctuation-only query does not match every field", () => {
  assert.equal(matchesSearchQuery("---", "prod-api-01"), false);
  assert.equal(matchesSearchQuery("-", "some-host"), false);
});

test("host search avoids compact hostname false positives on numeric segments", () => {
  assert.equal(
    matchesHostSearchQuery("61", {
      label: "核心交换机",
      hostname: "10.6.1.88",
      group: "网络设备",
      tags: [],
    }),
    false,
  );
});

test("host search scoring favors label over group when both match", () => {
  const labelHit = getHostSearchMatch("山东 6-1", {
    label: "山东-业务交换机6-1",
    hostname: "10.8.2.10",
    group: "网络设备/核心",
    tags: [],
  });
  const groupHit = getHostSearchMatch("山东 6-1", {
    label: "核心交换机",
    hostname: "10.8.2.11",
    group: "山东/业务交换机6-1",
    tags: [],
  });
  assert.equal(labelHit.matched, true);
  assert.equal(groupHit.matched, true);
  assert.equal(labelHit.score > groupHit.score, true);
});
