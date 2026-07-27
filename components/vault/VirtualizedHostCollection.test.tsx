import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  getNextRaggedRowPosition,
  getNextVirtualHostIndex,
  resolveVirtualFocusRequest,
  VirtualizedGroupedHostCollection,
  VirtualizedHostCollection,
} from "./VirtualizedHostCollection.tsx";
import { getVaultHostGridColumnCount } from "./vaultHostGridLayout.ts";

test("virtual focus retries when an active item enters a collection", () => {
  assert.deepEqual(resolveVirtualFocusRequest({
    activeItemKey: "host-1",
    lastRequestedKey: "host-1",
    itemIndexByKey: new Map(),
  }), { status: "missing" });

  assert.deepEqual(resolveVirtualFocusRequest({
    activeItemKey: "host-1",
    lastRequestedKey: null,
    itemIndexByKey: new Map([["host-1", 3]]),
  }), { status: "request", key: "host-1", index: 3 });
});

test("host grids use the same fixed card-width column calculation", () => {
  assert.equal(getVaultHostGridColumnCount(219), 1);
  assert.equal(getVaultHostGridColumnCount(452), 2);
  assert.equal(getVaultHostGridColumnCount(684), 3);
  assert.equal(getVaultHostGridColumnCount(916), 4);
  assert.equal(getVaultHostGridColumnCount(1600), 4);
});

test("virtualized host keyboard navigation crosses rows and collection edges", () => {
  assert.equal(getNextVirtualHostIndex({
    currentIndex: 1,
    itemCount: 20,
    columns: 4,
    viewMode: "grid",
    key: "ArrowDown",
  }), 5);
  assert.equal(getNextVirtualHostIndex({
    currentIndex: 5,
    itemCount: 20,
    columns: 4,
    viewMode: "grid",
    key: "ArrowLeft",
  }), 4);
  assert.equal(getNextVirtualHostIndex({
    currentIndex: 18,
    itemCount: 20,
    columns: 4,
    viewMode: "list",
    key: "End",
  }), 19);
  assert.equal(getNextVirtualHostIndex({
    currentIndex: 0,
    itemCount: 20,
    columns: 1,
    viewMode: "list",
    key: "ArrowUp",
  }), 0);
});

test("grouped grid navigation preserves the actual column across ragged rows", () => {
  assert.deepEqual(getNextRaggedRowPosition({
    rowLengths: [1, 3, 3],
    currentRow: 0,
    currentColumn: 0,
    direction: 1,
  }), { row: 1, column: 0 });
  assert.deepEqual(getNextRaggedRowPosition({
    rowLengths: [3, 1, 3],
    currentRow: 0,
    currentColumn: 2,
    direction: 1,
  }), { row: 1, column: 0 });
});

test("virtualized host grid renders only the viewport window for a large collection", () => {
  const items = Array.from({ length: 8000 }, (_, index) => ({ id: `host-${index}` }));
  const html = renderToStaticMarkup(
    <VirtualizedHostCollection
      items={items}
      itemKey={(item) => item.id}
      scrollRef={React.createRef<HTMLDivElement>()}
      viewMode="grid"
      ariaLabel="Hosts"
      renderItem={(item) => <div data-host-id={item.id} />}
    />,
  );

  const renderedHosts = (html.match(/data-host-id=/g) ?? []).length;
  assert.ok(renderedHosts > 0);
  assert.ok(renderedHosts < 100);
  assert.match(html, /data-vault-virtual-row=/);
  assert.match(html, /role="grid"/);
  assert.match(html, /aria-rowcount="2000"/);
  assert.match(html, /role="gridcell"/);
});

test("virtualized host list keeps one fixed-height item per row", () => {
  const items = Array.from({ length: 8000 }, (_, index) => ({ id: `host-${index}` }));
  const html = renderToStaticMarkup(
    <VirtualizedHostCollection
      items={items}
      itemKey={(item) => item.id}
      scrollRef={React.createRef<HTMLDivElement>()}
      viewMode="list"
      ariaLabel="Hosts"
      renderItem={(item) => <div data-host-id={item.id} />}
    />,
  );

  const renderedHosts = (html.match(/data-host-id=/g) ?? []).length;
  assert.ok(renderedHosts > 0);
  assert.ok(renderedHosts < 40);
  assert.match(html, /grid-template-columns:repeat\(1, minmax\(0, 1fr\)\)/);
  assert.match(html, /role="list"/);
  assert.match(html, /aria-setsize="8000"/);
});

test("grouped host grid uses one virtual window across every group", () => {
  const groups = Array.from({ length: 80 }, (_, groupIndex) => ({
    name: `group-${groupIndex}`,
    hosts: Array.from({ length: 100 }, (_, hostIndex) => ({
      id: `host-${groupIndex}-${hostIndex}`,
    })),
  }));
  const html = renderToStaticMarkup(
    <VirtualizedGroupedHostCollection
      groups={groups}
      itemKey={(item) => item.id}
      scrollRef={React.createRef<HTMLDivElement>()}
      viewMode="grid"
      ariaLabel="Hosts"
      renderGroupHeader={(group) => <div data-group-name={group.name} />}
      renderItem={(item) => <div data-host-id={item.id} />}
    />,
  );

  const renderedHosts = (html.match(/data-host-id=/g) ?? []).length;
  assert.ok(renderedHosts > 0);
  assert.ok(renderedHosts < 100);
  assert.equal((html.match(/data-vault-virtual-grouped-collection=/g) ?? []).length, 1);
});
