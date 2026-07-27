import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { GroupConfig, GroupNode, Host } from "../types.ts";
import {
  buildVisibleHostTreeItems,
  getHostTreeDisplayDetails,
  HostTreeView,
  useHostTreeExpandedPaths,
} from "./HostTreeView.tsx";

const baseHost: Host = {
  id: "host-1",
  label: "Router",
  hostname: "router.example.com",
  username: "ssh-user",
  port: 2222,
  protocol: "telnet",
  tags: [],
  os: "linux",
  createdAt: 1,
};

const installLocalStorageMock = () => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    },
  });
};

test("HostTreeView display details include inherited telnet defaults", () => {
  const host: Host = {
    ...baseHost,
    group: "network",
    username: "ssh-user",
    port: 2222,
    telnetUsername: undefined,
    telnetPort: undefined,
  };
  const groupConfigs: GroupConfig[] = [{
    path: "network",
    telnetUsername: "group-telnet-user",
    telnetPort: 2325,
  }];

  assert.deepEqual(getHostTreeDisplayDetails(host, groupConfigs), {
    protocol: "telnet",
    username: "group-telnet-user",
    port: 2325,
  });
});

test("HostTreeView display details keep explicit cleared telnet username", () => {
  const host: Host = {
    ...baseHost,
    group: "network",
    telnetUsername: "",
  };
  const groupConfigs: GroupConfig[] = [{
    path: "network",
    telnetUsername: "group-telnet-user",
    telnetPort: 2325,
  }];

  assert.deepEqual(getHostTreeDisplayDetails(host, groupConfigs), {
    protocol: "telnet",
    username: "",
    port: 2325,
  });
});

test("HostTreeView renders the host edit action beside the host label", () => {
  installLocalStorageMock();

  const markup = renderToStaticMarkup(
    <HostTreeView
      groupTree={[]}
      hosts={[{
        ...baseHost,
        notes: "Maintenance notes",
        tags: ["edge"],
      }]}
      onConnect={() => undefined}
      onEditHost={() => undefined}
      onDuplicateHost={() => undefined}
      onDeleteHost={() => undefined}
      onCopyCredentials={() => undefined}
      onNewGroup={() => undefined}
      onRenameGroup={() => undefined}
      onEditGroup={() => undefined}
      onDeleteGroup={() => undefined}
      moveHostToGroup={() => undefined}
      moveGroup={() => undefined}
    />,
  );

  const labelIndex = markup.indexOf("Router");
  const editButtonIndex = markup.indexOf('data-host-tree-host-edit-button="host-1"');
  const notesIndex = markup.indexOf('aria-label="Host notes"', labelIndex);
  const protocolIndex = markup.indexOf("TELNET", labelIndex);

  assert.ok(labelIndex >= 0);
  assert.ok(editButtonIndex > labelIndex);
  assert.ok(notesIndex > editButtonIndex);
  assert.ok(protocolIndex > notesIndex);
});

test("HostTreeView renders the group edit action beside the group label", () => {
  installLocalStorageMock();

  const groupNode: GroupNode = {
    name: "Production",
    path: "production",
    children: {},
    hosts: [],
    totalHostCount: 2,
  };

  const markup = renderToStaticMarkup(
    <HostTreeView
      groupTree={[groupNode]}
      hosts={[]}
      expandedPaths={new Set<string>()}
      onTogglePath={() => undefined}
      onConnect={() => undefined}
      onEditHost={() => undefined}
      onDuplicateHost={() => undefined}
      onDeleteHost={() => undefined}
      onCopyCredentials={() => undefined}
      onNewGroup={() => undefined}
      onRenameGroup={() => undefined}
      onEditGroup={() => undefined}
      onDeleteGroup={() => undefined}
      moveHostToGroup={() => undefined}
      moveGroup={() => undefined}
    />,
  );

  const labelIndex = markup.indexOf("Production");
  const editButtonIndex = markup.indexOf('data-host-tree-group-edit-button="production"');
  const countIndex = markup.indexOf(">2<", editButtonIndex);

  assert.ok(labelIndex >= 0);
  assert.ok(editButtonIndex > labelIndex);
  assert.ok(countIndex > editButtonIndex);
});

test("HostTreeView shows selected groups in multi-select mode", () => {
  installLocalStorageMock();

  const markup = renderToStaticMarkup(
    <HostTreeView
      groupTree={[{
        name: "Production",
        path: "production",
        children: {},
        hosts: [],
      }]}
      hosts={[]}
      expandedPaths={new Set<string>()}
      onTogglePath={() => undefined}
      onConnect={() => undefined}
      onEditHost={() => undefined}
      onDuplicateHost={() => undefined}
      onDeleteHost={() => undefined}
      onCopyCredentials={() => undefined}
      onNewGroup={() => undefined}
      onRenameGroup={() => undefined}
      onEditGroup={() => undefined}
      onDeleteGroup={() => undefined}
      moveHostToGroup={() => undefined}
      moveGroup={() => undefined}
      isMultiSelectMode
      selectedGroupPaths={new Set(["production"])}
      toggleGroupSelection={() => undefined}
    />,
  );

  assert.match(markup, /data-selected="true"/);
  assert.match(markup, /data-group-path="production"/);
  assert.match(markup, /role="tree"/);
  assert.match(markup, /aria-multiselectable="true"/);
  assert.match(markup, /role="treeitem"/);
  assert.match(markup, /aria-selected="true"/);
  assert.match(markup, /data-tree-item-key="group:production"/);
  assert.match(markup, /data-tree-depth="0"/);
  assert.match(markup, /aria-level="1"/);
  assert.match(markup, /tabindex="0"/);
  assert.doesNotMatch(markup, /aria-expanded=/);
  assert.doesNotMatch(markup, /data-host-tree-group-edit-button="production"/);
});

test("HostTreeView exposes selected hosts to keyboard and assistive technology", () => {
  installLocalStorageMock();

  const markup = renderToStaticMarkup(
    <HostTreeView
      groupTree={[]}
      hosts={[baseHost]}
      onConnect={() => undefined}
      onEditHost={() => undefined}
      onDuplicateHost={() => undefined}
      onDeleteHost={() => undefined}
      onCopyCredentials={() => undefined}
      onNewGroup={() => undefined}
      onRenameGroup={() => undefined}
      onEditGroup={() => undefined}
      onDeleteGroup={() => undefined}
      moveHostToGroup={() => undefined}
      moveGroup={() => undefined}
      isMultiSelectMode
      selectedHostIds={new Set([baseHost.id])}
      toggleHostSelection={() => undefined}
    />,
  );

  assert.match(markup, /role="tree"/);
  assert.match(markup, /data-host-id="host-1"[^>]*role="treeitem"/);
  assert.match(markup, /data-host-id="host-1"[^>]*aria-selected="true"/);
  assert.match(markup, /data-host-id="host-1"[^>]*data-tree-item-key="host:host-1"/);
  assert.match(markup, /data-host-id="host-1"[^>]*data-tree-depth="0"/);
  assert.match(markup, /data-host-id="host-1"[^>]*aria-level="1"/);
  assert.match(markup, /data-host-id="host-1"[^>]*tabindex="0"/);
});

test("HostTreeView exposes only one tree item in the tab order", () => {
  installLocalStorageMock();

  const markup = renderToStaticMarkup(
    <HostTreeView
      groupTree={[{
        name: "Production",
        path: "production",
        children: {},
        hosts: [],
      }]}
      hosts={[baseHost]}
      onConnect={() => undefined}
      onEditHost={() => undefined}
      onDuplicateHost={() => undefined}
      onDeleteHost={() => undefined}
      onCopyCredentials={() => undefined}
      onNewGroup={() => undefined}
      onRenameGroup={() => undefined}
      onEditGroup={() => undefined}
      onDeleteGroup={() => undefined}
      moveHostToGroup={() => undefined}
      moveGroup={() => undefined}
    />,
  );

  assert.equal(markup.match(/tabindex="0"/g)?.length, 1);
  assert.match(
    markup,
    /<button(?=[^>]*data-host-tree-group-edit-button="production")(?=[^>]*tabindex="-1")[^>]*>/,
  );
});

test("HostTreeView flattens only expanded group descendants", () => {
  const childHost = { ...baseHost, id: "child-host", group: "production" };
  const groupTree = [{
    name: "Production",
    path: "production",
    children: {},
    hosts: [childHost],
  }];

  assert.deepEqual(
    buildVisibleHostTreeItems({
      groupTree,
      ungroupedHosts: [baseHost],
      expandedPaths: new Set(),
      sortMode: "az",
      groupConfigs: [],
    }).map((item) => item.key),
    ["group:production", "host:host-1"],
  );
  assert.deepEqual(
    buildVisibleHostTreeItems({
      groupTree,
      ungroupedHosts: [baseHost],
      expandedPaths: new Set(["production"]),
      sortMode: "az",
      groupConfigs: [],
    }).map((item) => item.key),
    ["group:production", "host:child-host", "host:host-1"],
  );
});

test("HostTreeView keeps an explicit collapsed state after search auto-expands groups", () => {
  installLocalStorageMock();
  const childHost = { ...baseHost, id: "child-host", group: "production" };
  const markup = renderToStaticMarkup(
    <HostTreeView
      groupTree={[{
        name: "Production",
        path: "production",
        children: {},
        hosts: [childHost],
      }]}
      hosts={[childHost]}
      expandedPaths={new Set()}
      autoExpandGroupsKey="router"
      onTogglePath={() => undefined}
      onExpandAll={() => undefined}
      onCollapseAll={() => undefined}
      onConnect={() => undefined}
      onEditHost={() => undefined}
      onDuplicateHost={() => undefined}
      onDeleteHost={() => undefined}
      onCopyCredentials={() => undefined}
      onNewGroup={() => undefined}
      onRenameGroup={() => undefined}
      onEditGroup={() => undefined}
      onDeleteGroup={() => undefined}
      moveHostToGroup={() => undefined}
      moveGroup={() => undefined}
    />,
  );

  assert.match(markup, /data-group-path="production"[^>]*aria-expanded="false"/);
  assert.doesNotMatch(markup, /data-host-id="child-host"/);
});

test("HostTreeView search expansion is temporary and remains collapsible", async () => {
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  let persistentMutationCount = 0;
  let autoExpandGroupsKey: string | undefined = "router";
  let allGroupPaths = ["production"];
  let expandedPaths = new Set<string>();
  let collapseAll = () => undefined;
  let renderer: ReactTestRenderer | null = null;
  const Probe = () => {
    const state = useHostTreeExpandedPaths({
      persistentExpandedPaths: new Set(),
      allGroupPaths,
      autoExpandGroupsKey,
      onTogglePath: () => { persistentMutationCount++; },
      onExpandAll: () => { persistentMutationCount++; },
      onCollapseAll: () => { persistentMutationCount++; },
    });
    expandedPaths = state.expandedPaths;
    collapseAll = state.collapseAll;
    return null;
  };

  try {
    await act(async () => {
      renderer = create(React.createElement(Probe));
    });
    assert.equal(expandedPaths.has("production"), true);

    await act(async () => {
      collapseAll();
    });
    assert.equal(expandedPaths.has("production"), false);
    assert.equal(persistentMutationCount, 0);

    await act(async () => {
      allGroupPaths = ["production", "staging"];
      renderer!.update(React.createElement(Probe));
    });
    assert.equal(expandedPaths.has("production"), false);
    assert.equal(expandedPaths.has("staging"), true);
    assert.equal(persistentMutationCount, 0);

    await act(async () => {
      autoExpandGroupsKey = undefined;
      renderer!.update(React.createElement(Probe));
    });
    assert.equal(expandedPaths.has("production"), false);
    assert.equal(persistentMutationCount, 0);
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

test("HostTreeView virtualizes an 8,000-host tree", () => {
  installLocalStorageMock();
  const hosts = Array.from({ length: 8000 }, (_, index) => ({
    ...baseHost,
    id: `host-${index}`,
    label: `Host ${String(index).padStart(4, "0")}`,
  }));

  const markup = renderToStaticMarkup(
    <HostTreeView
      groupTree={[]}
      hosts={hosts}
      onConnect={() => undefined}
      onEditHost={() => undefined}
      onDuplicateHost={() => undefined}
      onDeleteHost={() => undefined}
      onCopyCredentials={() => undefined}
      onNewGroup={() => undefined}
      onRenameGroup={() => undefined}
      onEditGroup={() => undefined}
      onDeleteGroup={() => undefined}
      moveHostToGroup={() => undefined}
      moveGroup={() => undefined}
    />,
  );

  const renderedHosts = markup.match(/data-host-id=/g)?.length ?? 0;
  assert.ok(renderedHosts > 0);
  assert.ok(renderedHosts < 100);
  assert.match(markup, /data-vault-virtual-tree="true"/);
  assert.match(markup, /height:320000px/);
  // Flat ungrouped hosts share one sibling set at the root level.
  assert.match(markup, /aria-setsize="8000"/);
  assert.match(markup, /aria-posinset="1"/);
  assert.match(markup, /role="treeitem"/);
});

test("HostTreeView announces sibling position within each tree level", () => {
  installLocalStorageMock();
  const groupTree: GroupNode[] = [{
    name: "prod",
    path: "prod",
    hosts: [
      { ...baseHost, id: "host-a", label: "A", group: "prod" },
      { ...baseHost, id: "host-b", label: "B", group: "prod" },
    ],
    children: {
      east: {
        name: "east",
        path: "prod/east",
        hosts: [{ ...baseHost, id: "host-c", label: "C", group: "prod/east" }],
        children: {},
      },
    },
  }];
  const hosts = [
    { ...baseHost, id: "host-a", label: "A", group: "prod" },
    { ...baseHost, id: "host-b", label: "B", group: "prod" },
    { ...baseHost, id: "host-c", label: "C", group: "prod/east" },
    { ...baseHost, id: "host-root", label: "Root", group: "" },
  ];
  const items = buildVisibleHostTreeItems({
    groupTree,
    ungroupedHosts: hosts.filter((host) => !host.group),
    expandedPaths: new Set(["prod", "prod/east"]),
    sortMode: "az",
    groupConfigs: [],
  });

  const byKey = new Map(items.map((item) => [item.key, item]));
  // Root siblings: prod group + ungrouped host-root
  assert.equal(byKey.get("group:prod")?.posInSet, 1);
  assert.equal(byKey.get("group:prod")?.setSize, 2);
  assert.equal(byKey.get("host:host-root")?.posInSet, 2);
  assert.equal(byKey.get("host:host-root")?.setSize, 2);
  // Children of prod: east group + hosts A/B
  assert.equal(byKey.get("group:prod/east")?.posInSet, 1);
  assert.equal(byKey.get("group:prod/east")?.setSize, 3);
  assert.equal(byKey.get("host:host-a")?.setSize, 3);
  assert.equal(byKey.get("host:host-b")?.setSize, 3);
  // Child of prod/east: only host C
  assert.equal(byKey.get("host:host-c")?.posInSet, 1);
  assert.equal(byKey.get("host:host-c")?.setSize, 1);
});
