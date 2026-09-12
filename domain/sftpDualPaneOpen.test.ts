import test from "node:test";
import assert from "node:assert/strict";

import {
  applyDualPaneSftpOpen,
  canOpenDualPaneSftp,
  dualPaneTabFromPane,
  planDualPaneSftpOpen,
  type DualPaneSftpTab,
} from "./sftpDualPaneOpen.ts";

const tab = (
  id: string,
  options: Partial<DualPaneSftpTab> = {},
): DualPaneSftpTab => ({
  id,
  isLocal: false,
  hostId: null,
  endpointKey: "endpoint-1",
  hasConnection: true,
  ...options,
});

test("canOpenDualPaneSftp matches the SFTP host picker: not serial, not plugin", () => {
  assert.equal(canOpenDualPaneSftp({}), true);
  assert.equal(canOpenDualPaneSftp({ protocol: "ssh" }), true);
  assert.equal(canOpenDualPaneSftp({ protocol: "mosh" }), true);
  assert.equal(canOpenDualPaneSftp({ protocol: "telnet" }), true);
  assert.equal(canOpenDualPaneSftp({ protocol: "serial" }), false);
  assert.equal(canOpenDualPaneSftp({ protocol: "plugin:example.provider.ssh" }), false);
});

test("planDualPaneSftpOpen connects local left and host right on empty panes", () => {
  assert.deepEqual(
    planDualPaneSftpOpen({ leftTabs: [], rightTabs: [], hostId: "host-1", hostEndpointKey: "endpoint-1" }),
    {
      selectLeftTabId: null,
      connectLeftLocal: true,
      addLeftTab: false,
      selectRightTabId: null,
      connectRightHost: true,
      addRightTab: false,
    },
  );
});

test("planDualPaneSftpOpen reuses an existing local left tab and matching right host", () => {
  const plan = planDualPaneSftpOpen({
    leftTabs: [tab("left-remote", { hostId: "other" }), tab("left-local", { isLocal: true, hostId: "local" })],
    rightTabs: [tab("right-host", { hostId: "host-1" })],
    hostId: "host-1",
    hostEndpointKey: "endpoint-1",
  });
  assert.deepEqual(plan, {
    selectLeftTabId: "left-local",
    connectLeftLocal: false,
    addLeftTab: false,
    selectRightTabId: "right-host",
    connectRightHost: false,
    addRightTab: false,
  });
});

test("planDualPaneSftpOpen uses idle panes instead of adding tabs", () => {
  const plan = planDualPaneSftpOpen({
    leftTabs: [tab("left-idle", { hasConnection: false })],
    rightTabs: [tab("right-idle", { hasConnection: false })],
    hostId: "host-1",
    hostEndpointKey: "endpoint-1",
  });
  assert.equal(plan.selectLeftTabId, "left-idle");
  assert.equal(plan.connectLeftLocal, true);
  assert.equal(plan.addLeftTab, false);
  assert.equal(plan.selectRightTabId, "right-idle");
  assert.equal(plan.connectRightHost, true);
  assert.equal(plan.addRightTab, false);
});

test("applyDualPaneSftpOpen selects existing tabs without reconnecting", () => {
  const calls: string[] = [];
  const plan = applyDualPaneSftpOpen(
    {
      leftTabs: [tab("left-local", { isLocal: true, hostId: "local" })],
      rightTabs: [tab("right-host", { hostId: "host-1" })],
      selectTab: (side, tabId) => calls.push(`select:${side}:${tabId}`),
      connect: (side, host, options) => {
        const target = host === "local" ? "local" : host.id;
        const mode = options?.forceNewTab ? "new" : (options?.tabId ? `tab:${options.tabId}` : "reuse");
        calls.push(`connect:${side}:${target}:${mode}`);
      },
    },
    { id: "host-1" },
    "endpoint-1",
  );
  assert.equal(plan.connectLeftLocal, false);
  assert.equal(plan.connectRightHost, false);
  assert.deepEqual(calls, ["select:left:left-local", "select:right:right-host"]);
});

test("dualPaneTabFromPane treats error and disconnected tabs as idle", () => {
  assert.deepEqual(
    dualPaneTabFromPane({
      id: "right-dead",
      connection: { isLocal: false, hostId: "host-1", status: "error" },
    }),
    { id: "right-dead", isLocal: false, hostId: "host-1", endpointKey: null, hasConnection: false },
  );
  assert.deepEqual(
    dualPaneTabFromPane({
      id: "right-live",
      connection: { isLocal: false, hostId: "host-1", status: "connected" },
    }),
    { id: "right-live", isLocal: false, hostId: "host-1", endpointKey: null, hasConnection: true },
  );
});

test("planDualPaneSftpOpen prefers a matching dead host tab over an earlier idle tab", () => {
  const idle = tab("right-idle", { hasConnection: false });
  const dead = dualPaneTabFromPane({
    id: "right-dead",
    connection: { isLocal: false, hostId: "host-1", status: "error" },
  });
  const plan = planDualPaneSftpOpen({
    leftTabs: [tab("left-local", { isLocal: true, hostId: "local" })],
    rightTabs: [idle, dead],
    hostId: "host-1",
    hostEndpointKey: "endpoint-1",
  });
  assert.equal(plan.selectRightTabId, "right-dead");
  assert.equal(plan.connectRightHost, true);
  assert.equal(plan.addRightTab, false);
});

test("planDualPaneSftpOpen reconnects a matching host tab that is no longer live", () => {
  const dead = dualPaneTabFromPane({
    id: "right-dead",
    connection: { isLocal: false, hostId: "host-1", status: "error" },
  });
  const plan = planDualPaneSftpOpen({
    leftTabs: [tab("left-local", { isLocal: true, hostId: "local" })],
    rightTabs: [dead],
    hostId: "host-1",
    hostEndpointKey: "endpoint-1",
  });
  assert.deepEqual(plan, {
    selectLeftTabId: "left-local",
    connectLeftLocal: false,
    addLeftTab: false,
    selectRightTabId: "right-dead",
    connectRightHost: true,
    addRightTab: false,
  });
});

test("applyDualPaneSftpOpen adds tabs when both sides are occupied by other hosts", () => {
  const calls: string[] = [];
  applyDualPaneSftpOpen(
    {
      leftTabs: [tab("left-remote", { hostId: "other" })],
      rightTabs: [tab("right-other", { hostId: "other" })],
      selectTab: (side, tabId) => calls.push(`select:${side}:${tabId}`),
      connect: (side, host, options) => {
        const target = host === "local" ? "local" : host.id;
        const mode = options?.forceNewTab ? "new" : (options?.tabId ? `tab:${options.tabId}` : "reuse");
        calls.push(`connect:${side}:${target}:${mode}`);
      },
    },
    { id: "host-1" },
    "endpoint-1",
  );
  assert.deepEqual(calls, [
    "connect:left:local:new",
    "connect:right:host-1:new",
  ]);
});

test("planDualPaneSftpOpen does not reuse a live tab after the saved endpoint changes", () => {
  const plan = planDualPaneSftpOpen({
    leftTabs: [tab("left-local", { isLocal: true, hostId: "local" })],
    rightTabs: [tab("right-stale", { hostId: "host-1", endpointKey: "old-endpoint" })],
    hostId: "host-1",
    hostEndpointKey: "new-endpoint",
  });

  assert.equal(plan.selectRightTabId, null);
  assert.equal(plan.connectRightHost, true);
  assert.equal(plan.addRightTab, true);
});
