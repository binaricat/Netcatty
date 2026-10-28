import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { I18nProvider } from "../../application/i18n/I18nProvider";
import { writeMonitorPanels } from "../../application/state/monitorPanelsStorage";
import type { Host } from "../../domain/models";
import type { MonitorPoint } from "../../domain/monitorRuntime";
import { MonitorPanels, MonitorTrend } from "./MonitorPanels";
import { MonitorDiskUsage } from "./MonitorDiskUsage";
import { MonitorDiskIo } from "./MonitorDiskIo";
import { MonitorHostLatency } from "./MonitorHostMetadata";
import { TooltipProvider } from "../ui/tooltip";

test("latency signals use the stats response when transport ping is unavailable and prefer valid ping readings", () => {
  for (const [ping, response, bars, label] of [
    [null, 145, "2", "Response latency (includes remote processing): 145 ms"],
    [0, 500, "4", "Latency: 0 ms"],
    [NaN, 450, "1", "Response latency (includes remote processing): 450 ms"],
    [null, null, "0", "Latency: --"],
  ] as const) {
    const document = new JSDOM(renderToStaticMarkup(
      <I18nProvider locale="en"><TooltipProvider>
        <MonitorHostLatency value={ping} responseValue={response} />
      </TooltipProvider></I18nProvider>,
    )).window.document;
    const signal = document.querySelector("[data-monitor-latency]")!;
    assert.equal(signal.getAttribute("data-monitor-signal-bars"), bars);
    assert.equal(signal.getAttribute("aria-label"), label);
  }
});

const now = 1_800_000_000_000;
const point = (ago: number, cpu: number | null): MonitorPoint => ({
  at: now - ago,
  cpu,
  memory: null,
  disk: null,
  rx: null,
  tx: null,
});
const trend = (points: MonitorPoint[]) => new JSDOM(renderToStaticMarkup(
  <MonitorTrend clock={0} points={points} field="cpu" range={5} interval={10} label="CPU trend" />,
)).window.document;

test("unchanged series reuse geometry but age out when the viewport clock advances", async (t) => {
  const dom = new JSDOM("<div id='root'></div>");
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const originals = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  let current = now;
  t.mock.method(Date, "now", () => current);
  const root = createRoot(dom.window.document.getElementById("root")!);
  const samples = [point(1000, 42)];
  try {
    await act(async () => root.render(<MonitorTrend clock={0} points={samples} field="cpu" range={5} interval={60} label="CPU" />));
    const path = dom.window.document.querySelector("svg g path")!.getAttribute("d");
    current += 1000;
    await act(async () => root.render(<MonitorTrend clock={0} points={samples} field="cpu" range={5} interval={60} label="CPU updated" />));
    assert.equal(dom.window.document.querySelector("svg g path")!.getAttribute("d"), path);
    current += 6 * 60000;
    await act(async () => root.render(<MonitorTrend clock={1} points={samples} field="cpu" range={5} interval={60} label="CPU updated" />));
    assert.equal(dom.window.document.querySelectorAll("svg g path, svg circle").length, 0);
  } finally {
    await act(async () => root.unmount());
    for (const key of Object.keys(globals)) {
      const descriptor = originals[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});

test("empty trends do not draw a reading", (t) => {
  t.mock.method(Date, "now", () => now);
  const document = trend([]);
  assert.equal(document.querySelectorAll("svg g path, svg circle").length, 0);
});

test("a first reading is visible at its actual time without invented history", (t) => {
  t.mock.method(Date, "now", () => now);
  const document = trend([point(1000, 40)]);
  const dot = document.querySelector("circle")!;
  assert.equal(Number(dot.getAttribute("cx")), 299);
  assert.equal(document.querySelector('g path[fill="none"]')!.getAttribute("d"), "M 299.00 36.40");
  const area = document.querySelector("g path")!.getAttribute("d")!;
  assert.equal(area, "M 299.00 36.40 L 299.00 58 L 299.00 58 Z");
});

test("trend lines and shaded areas break at missing readings and collection gaps", (t) => {
  t.mock.method(Date, "now", () => now);
  for (const points of [
    [point(40000, 20), point(30000, null), point(20000, 30), point(10000, 40)],
    [point(50000, 20), point(10000, 30), point(0, 40)],
  ]) {
    const document = trend(points);
    const segments = [...document.querySelectorAll("svg g")];
    assert.equal(segments.length, 2);
    assert.equal(segments[0].querySelector('path[fill="none"]')!.getAttribute("d")!.includes(" L "), false);
    assert.equal(segments[1].querySelector('path[fill="none"]')!.getAttribute("d")!.includes(" L "), true);
    // Each area starts at its own segment, rather than extending to the chart origin.
    for (const segment of segments) {
      const firstX = segment.querySelector("path")!.getAttribute("d")!.split(" ")[1];
      assert.ok(Number(firstX) > 0);
      assert.ok(segment.querySelector("path")!.getAttribute("d")!.endsWith(`L ${firstX} 58 Z`));
    }
  }
});

test("multiple host charts use independent gradient references", () => {
  const document = new JSDOM(renderToStaticMarkup(<>
    <MonitorTrend clock={0} points={[]} field="cpu" range={5} interval={10} label="CPU" />
    <MonitorTrend clock={0} points={[]} field="memory" range={5} interval={10} label="Memory" />
  </>)).window.document;
  const ids = [...document.querySelectorAll("linearGradient")].map((g) => g.id);
  assert.equal(new Set(ids).size, 2);
});

const hosts: Host[] = [
  { id: "custom", label: "Cloud host", hostname: "cloud.example.com", username: "test", port: 22, os: "linux", tags: [], createdAt: 1, iconMode: "custom", iconId: "cloud", iconColorMode: "manual", iconColorCustom: "#9333EA" },
  { id: "brand", label: "Ubuntu host", hostname: "ubuntu.example.com", username: "test", port: 22, os: "linux", tags: [], createdAt: 1, distro: "ubuntu" },
];

test("disk usage shows every reported partition, including healthy and empty disks", () => {
  const disks = [
    { mountPoint: "/", used: 25, total: 100, percent: 25 },
    { mountPoint: "/data", used: 95, total: 100, percent: 95 },
    { mountPoint: "/backup", used: 0, total: 100, percent: 0 },
  ];
  const document = new JSDOM(renderToStaticMarkup(
    <MonitorDiskUsage stats={{ disks, diskPercent: 25 }} />,
  )).window.document;
  assert.deepEqual([...document.querySelectorAll("[data-monitor-disk-label]")].map((e) => e.textContent), ["/", "/backup", "/data"]);
  for (const value of ["25.0%", "95.0%", "0.0%"])
    assert.ok(document.body.textContent!.includes(value));
});

test("disk usage retains a root-only reading and leaves missing data unknown", () => {
  const known = renderToStaticMarkup(<MonitorDiskUsage stats={{ disks: [], diskPercent: 42 }} />);
  const unknown = renderToStaticMarkup(<MonitorDiskUsage />);
  assert.ok(known.includes("42.0%"));
  assert.ok(unknown.includes("--"));
  assert.ok(!unknown.includes("0.0%"));
});

test("cards show the two largest capacities without changing the source disk order", () => {
  const disks = [
    { mountPoint: "/small", used: 49, total: 50, percent: 98 },
    { mountPoint: "/data", used: 100, total: 1000, percent: 10 },
    { mountPoint: "/backup", used: 0, total: 500, percent: 0 },
  ];
  const document = new JSDOM(renderToStaticMarkup(
    <MonitorDiskUsage stats={{ disks, diskPercent: 98 }} limit={2} />,
  )).window.document;
  assert.deepEqual([...document.querySelectorAll("[data-monitor-disk] > span")].map((e) => e.textContent), ["/data", "/backup"]);
  assert.deepEqual(disks.map((disk) => disk.mountPoint), ["/small", "/data", "/backup"]);
});

test("cards retain aggregate disk I/O while lists keep it in the separate column", () => {
  const stats = { disks: [], diskPercent: 10, diskReadSpeed: 1000, diskWriteSpeed: 2e6 };
  const markup = (limit?: number) => new JSDOM(renderToStaticMarkup(
    <I18nProvider locale="en"><MonitorDiskUsage stats={stats} limit={limit} /></I18nProvider>,
  )).window.document;
  assert.match(markup(2).querySelector("[data-disk-io]")!.textContent!, /Read 1.0 KB\/s.*Write 2.0 MB\/s/);
  assert.equal(markup().querySelector("[data-disk-io]"), null);
});

for (const view of ["list", "charts"] as const) {
  test(`${view} keeps saved custom icons, colors and OS logos`, (t) => {
    const storage = new Map<string, string>();
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    } });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else Reflect.deleteProperty(globalThis, "localStorage");
    });
    writeMonitorPanels([{ id: "panel", name: "Panel", description: "", hostIds: hosts.map((h) => h.id), view, interval: 10, range: 15, sort: "manual" }]);
    const document = new JSDOM(renderToStaticMarkup(
      <I18nProvider locale="en"><MonitorPanels hosts={hosts} customGroups={[]} onConnect={() => {}} /></I18nProvider>,
    )).window.document;
    const icon = document.querySelector(".lucide-cloud")!;
    assert.ok(icon);
    assert.equal((icon.parentElement as HTMLElement).style.backgroundColor, "rgb(147, 51, 234)");
    assert.ok(document.querySelector('img[src="/distro/ubuntu.svg"]'));
    assert.equal(document.querySelector("header .lucide-gauge"), null);
    assert.equal(document.querySelector(".lucide-activity"), null);
    if (view === "list") {
      const diskIo = document.querySelector("[data-monitor-cell=diskIo]")!;
      assert.ok(diskIo.querySelector("[data-monitor-disk-io-total]"));
      assert.equal(document.querySelector("[data-monitor-column=diskIo]")?.textContent, "Disk I/O");
      const network = document.querySelector("[data-monitor-cell=network]")!;
      assert.deepEqual([...network.querySelectorAll(".sr-only")].map((e) => e.textContent), ["Download: ", "Upload: "]);
    }
  });
}

test("disk I/O distinguishes warming up or unsupported from idle and reports both rates", () => {
  for (const [rates, expected] of [
    [{}, ["Read --", "Write --"]],
    [{ diskReadSpeed: null, diskWriteSpeed: null }, ["Read --", "Write --"]],
    [{ diskReadSpeed: 0, diskWriteSpeed: 0 }, ["Read 0.0 KB/s", "Write 0.0 KB/s"]],
    [{ diskReadSpeed: 1000, diskWriteSpeed: 2000000 }, ["Read 1.0 KB/s", "Write 2.0 MB/s"]],
  ] as const) {
    const document = new JSDOM(renderToStaticMarkup(
      <I18nProvider locale="en"><MonitorDiskIo stats={{ disks: [{ mountPoint: "/", used: 1, total: 10, percent: 10, ...rates }] }} /></I18nProvider>,
    )).window.document;
    const io = document.querySelector("[data-monitor-disk-io]")!;
    for (const text of expected) assert.ok(io.textContent?.includes(text));
    assert.match(io.getAttribute("title")!, /block device.*not supported on macOS/);
  }
});


test("disk capacity and I/O columns share system-first order and isolate the physical aggregate", () => {
  const stats = {
    diskPercent: 10, diskReadSpeed: 5000000, diskWriteSpeed: 2000000000,
    disks: [
      { mountPoint: "/", used: 1, total: 10, percent: 10, diskReadSpeed: 1000, diskWriteSpeed: 0 },
      { mountPoint: "/bd10", used: 2, total: 20, percent: 10, diskReadSpeed: 2000000, diskWriteSpeed: 4000 },
      { mountPoint: "/bd02", used: 1, total: 10, percent: 10, diskReadSpeed: 1000, diskWriteSpeed: 0 },
    ],
  };
  const document = new JSDOM(renderToStaticMarkup(
    <I18nProvider locale="en"><div data-capacity><MonitorDiskUsage stats={stats} /></div><MonitorDiskIo stats={stats} /></I18nProvider>,
  )).window.document;
  const capacity = document.querySelector("[data-capacity]")!;
  const rows = [...document.querySelectorAll("[data-monitor-disk-io]")];
  assert.equal(capacity.querySelectorAll("[data-disk-io], [data-monitor-disk-io]").length, 0);
  assert.deepEqual(rows.map(row => row.getAttribute("data-monitor-disk-io")),
    [...capacity.querySelectorAll("[data-monitor-disk]")].map(row => row.getAttribute("data-monitor-disk")));
  assert.match(rows[0].textContent!, /Read 1.0 KB\/s.*Write 0.0 KB\/s/);
  assert.deepEqual(rows.map(row => row.getAttribute("data-monitor-disk-io")), ["/", "/bd02", "/bd10"]);
  assert.match(rows[2].textContent!, /Read 2.0 MB\/s.*Write 4.0 KB\/s/);
  const total = document.querySelector("[data-monitor-disk-io-total]")!;
  assert.match(total.textContent!, /Total.*Read 5.0 MB\/s.*Write 2.0 GB\/s/);
});
