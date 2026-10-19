import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useVaultHostCollections } from "../../components/vault/useVaultHostCollections";
import { VirtualizedHostCollection } from "../../components/vault/VirtualizedHostCollection";
import type { GroupConfig, Host, KnownHost } from "../../types";

const hosts: Host[] = Array.from({ length: 5000 }, (_, index) => ({
  id: `host-${index}`,
  label: `Production Host ${index}`,
  hostname: `10.${(index >> 16) % 256}.${(index >> 8) % 256}.${index % 256}`,
  username: "fixture",
  notes: "Deployment host",
  tags: ["production", "web"],
  group: `Region ${index % 100}`,
  port: 22,
  os: "linux",
  createdAt: 1,
}));
const groups = Array.from({ length: 100 }, (_, index) => `Region ${index}`);
const groupConfigs: GroupConfig[] = [];
const knownHosts: KnownHost[] = [];
const selectedTags: string[] = [];
const noop = () => {};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let current: ReturnType<typeof useVaultHostCollections>;

function VaultSearchFixture() {
  const [search, setSearch] = useState("");
  current = useVaultHostCollections({
    hosts, customGroups: groups, groupConfigs, knownHosts,
    onConvertKnownHost: noop, onUpdateHosts: noop, onUpdateKnownHosts: noop,
    search, selectedGroupPath: null, selectedTags,
    showOnlyUngroupedHostsInRoot: false, showRecentHosts: false,
    sortMode: "ip", viewMode: "list",
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  return <>
    <label>Search hosts <input value={search} onChange={(event) => setSearch(event.target.value)} /></label>
    <output>{search}</output>
    <div ref={scrollRef} style={{ height: 650, width: 1200, overflow: "auto" }}>
      <VirtualizedHostCollection
        items={current.displayedHosts}
        itemKey={(host) => host.id}
        renderItem={(host) => <button data-host-id={host.id}>{host.label}</button>}
        scrollRef={scrollRef}
        viewMode="list"
      />
    </div>
  </>;
}

export async function runVaultSearchPerformance() {
  const rootNode = document.getElementById("root");
  if (!rootNode) throw new Error("Missing fixture root");
  const root = createRoot(rootNode);
  flushSync(() => root.render(<VaultSearchFixture />));
  await wait(100);
  const input = rootNode.querySelector("input");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!input || !setter) throw new Error("Missing search input");
  const rows = [];
  const queries = ["", "P", "Pr", "Pro", "Prod", "production", "production w", "production we", "production web", "", "R", "Re", "Reg", "Region", "Region 9", "Region 99", "", "no", "no-m", "no-match", "no-match-query"];
  for (let round = 0; round < 3; round++) {
    for (const query of queries) {
      let resolveInput!: (ms: number) => void;
      const started = performance.now();
      const nextInputTurn = new Promise<number>((resolve) => { resolveInput = resolve; });
      setTimeout(() => resolveInput(performance.now() - started), 0);
      flushSync(() => {
        setter.call(input, query);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const renderMs = performance.now() - started;
      const inputDelayMs = await nextInputTurn;
      const ids = current.displayedHosts.map((host) => host.id).join(",");
      // A compact fingerprint lets before/after runs compare complete order,
      // without recording thousands of host IDs for every input event.
      let orderHash = 0;
      for (const char of ids) orderHash = ((orderHash << 5) - orderHash + char.charCodeAt(0)) | 0;
      rows.push({ round, query, renderMs, inputDelayMs, orderHash,
        matches: current.displayedHosts.length,
        actualInput: rootNode.querySelector("output")?.textContent,
        mountedHosts: rootNode.querySelectorAll("[data-host-id]").length });
      await wait(30);
    }
  }
  root.unmount();
  return rows;
}
