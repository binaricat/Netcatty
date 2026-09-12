import assert from "node:assert/strict";
import test from "node:test";

import {
  PINYIN_CACHE_MAX_ENTRIES,
  getPinyinCacheStatsForTests,
  getHostSearchMatch,
  matchesHostSearchQuery,
  matchesSearchQuery,
  resetPinyinCacheForTests,
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

test("pinyin cache covers 8000 hosts and stays hard-bounded through import/edit churn", () => {
  resetPinyinCacheForTests();
  const startedAt = performance.now();
  for (let index = 0; index < 8_000; index += 1) {
    matchesHostSearchQuery("z", { label: `主机${index}` });
  }
  const firstPassMs = performance.now() - startedAt;
  assert.equal(getPinyinCacheStatsForTests().size, 8_000);
  assert.ok(firstPassMs < 10_000, `8000-host pinyin indexing took ${firstPassMs.toFixed(1)}ms`);

  matchesHostSearchQuery("z", { label: "主机0" });
  for (let index = 8_000; index < PINYIN_CACHE_MAX_ENTRIES + 128; index += 1) {
    matchesHostSearchQuery("z", { label: `主机${index}` });
  }

  const stats = getPinyinCacheStatsForTests();
  assert.equal(stats.size, PINYIN_CACHE_MAX_ENTRIES);
  assert.ok(stats.keys.includes("主机0"));
  assert.ok(!stats.keys.includes("主机1"));
  resetPinyinCacheForTests();
});
