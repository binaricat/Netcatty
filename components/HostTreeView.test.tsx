import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { GroupConfig, GroupNode, Host } from "../types.ts";
import { getHostTreeDisplayDetails, HostTreeView } from "./HostTreeView.tsx";

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
