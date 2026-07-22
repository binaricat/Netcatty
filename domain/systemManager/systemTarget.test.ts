import assert from "node:assert/strict";
import test from "node:test";

import { buildSystemManagerTabs, shouldCollectServerStats } from "./systemTarget.ts";

test("system manager shows overview before detailed management tabs", () => {
  assert.deepEqual(buildSystemManagerTabs(null, undefined, null), ["overview", "processes"]);
});

test("system overview stats skip network devices even when a Linux icon was selected", () => {
  assert.equal(
    shouldCollectServerStats(
      {
        id: "host-1",
        label: "Router",
        hostname: "router.local",
        username: "admin",
        tags: [],
        os: "linux",
        deviceType: "network",
      },
      undefined,
      null,
    ),
    false,
  );
});

test("system overview stats run for Linux and macOS targets", () => {
  assert.equal(
    shouldCollectServerStats(
      {
        id: "host-1",
        label: "Linux",
        hostname: "linux.local",
        username: "root",
        tags: [],
        os: "linux",
      },
      undefined,
      null,
    ),
    true,
  );
  assert.equal(
    shouldCollectServerStats(
      {
        id: "host-2",
        label: "Mac",
        hostname: "mac.local",
        username: "root",
        tags: [],
        os: "macos",
      },
      undefined,
      null,
    ),
    true,
  );
});

test("FreeBSD icon detection does not enable unsupported system features", () => {
  const host = {
    id: "host-3",
    label: "FreeBSD",
    hostname: "freebsd.local",
    username: "root",
    tags: [],
    os: "linux" as const,
    distro: "freebsd",
  };

  assert.equal(shouldCollectServerStats(host, undefined, null), false);
  assert.deepEqual(buildSystemManagerTabs(host, undefined, null), ["overview", "processes"]);
});
