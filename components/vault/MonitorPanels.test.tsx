import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { I18nProvider } from "../../application/i18n/I18nProvider";
import { writeMonitorPanels } from "../../application/state/monitorPanelsStorage";
import { monitorActions, publishMonitorSnapshot } from "../../application/state/monitorRuntimeStore";
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
    assert.equal(io.getAttribute("title"), null);
    assert.match(io.getAttribute("aria-label")!, /block device.*not supported on macOS/);
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

test("standalone RDP/VNC hosts render reachability & RTT trend without CPU/RAM gauges, bypass SSH login modal on retry, and SSH+companion shows desktop pills", async (t) => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost/" });
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", { configurable: true, value: 1280 });
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", { configurable: true, value: 800 });
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetWidth", { configurable: true, value: 1280 });
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", { configurable: true, value: 800 });
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
    x: 0, y: 0, top: 0, left: 0, right: 1280, bottom: 800, width: 1280, height: 800, toJSON: () => ({}),
  });
  const raf = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number;
  const caf = (id: number) => clearTimeout(id);
  class MockResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(dom.window, "requestAnimationFrame", { configurable: true, writable: true, value: raf });
  Object.defineProperty(dom.window, "cancelAnimationFrame", { configurable: true, writable: true, value: caf });
  Object.defineProperty(dom.window, "ResizeObserver", { configurable: true, writable: true, value: MockResizeObserver });
  const storage = new Map<string, string>();
  const mockLocalStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
    key: () => null,
    length: 0,
  };
  const globals: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    SVGElement: dom.window.SVGElement,
    localStorage: mockLocalStorage,
    ResizeObserver: MockResizeObserver,
    requestAnimationFrame: raf,
    cancelAnimationFrame: caf,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const originals = Object.fromEntries(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  const ts = Date.now();
  const rdpHost: Host = {
    id: "rdp-win",
    label: "Win Desktop",
    hostname: "win.lan",
    username: "admin",
    port: 3389,
    os: "windows",
    protocol: "rdp",
    tags: [],
    createdAt: 1,
  };
  const sshHost: Host = {
    id: "ssh-comp",
    label: "Linux Workstation",
    hostname: "linux.lan",
    username: "dev",
    port: 22,
    os: "linux",
    protocol: "ssh",
    vncConfig: { enabled: true, port: 5900, tunnelViaHostSsh: true },
    tags: [],
    createdAt: 1,
  };

  const retried: Array<{ id: string; creds?: unknown }> = [];
  const origRetry = monitorActions.retry;
  monitorActions.retry = (id, creds) => {
    retried.push({ id, creds });
  };

  const root = createRoot(dom.window.document.getElementById("root")!);
  t.after(async () => {
    monitorActions.retry = origRetry;
    await act(async () => root.unmount());
    publishMonitorSnapshot({
      historyMode: "replace",
      runtimeId: "reset",
      epoch: 99,
      takenAt: ts + 10_000,
      running: [],
      startedAt: {},
      count: 0,
      hostCount: 0,
      activeSessions: [],
      hosts: {},
    });
    for (const key of Object.keys(globals)) {
      const descriptor = originals[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  });

  publishMonitorSnapshot({
    historyMode: "replace",
    runtimeId: "probe-test",
    epoch: 1,
    takenAt: ts,
    running: ["p-rd"],
    startedAt: { "p-rd": ts - 10_000 },
    count: 1,
    hostCount: 2,
    activeSessions: [],
    hosts: {
      "rdp-win": {
        historyId: "h-rdp",
        mode: "probe",
        status: "live",
        at: ts,
        statsAt: ts,
        probe: {
          protocol: "rdp",
          port: 3389,
          reachable: true,
          rttMs: 24,
          bannerVerified: true,
          bannerDetail: "RDP (NLA / CredSSP)",
          checkedAt: ts,
        },
        points: [
          { at: ts - 5000, cpu: null, memory: null, disk: null, rx: null, tx: null, latencyMs: 22 },
          { at: ts, cpu: null, memory: null, disk: null, rx: null, tx: null, latencyMs: 24 },
        ],
      },
      "ssh-comp": {
        historyId: "h-ssh",
        mode: "ssh",
        status: "live",
        at: ts,
        statsAt: ts,
        stats: {
          cpu: 30,
          cpuCores: 4,
          cpuPerCore: [],
          memTotal: 1000,
          memUsed: 400,
          memFree: 600,
          memBuffers: 0,
          memCached: 0,
          swapTotal: 0,
          swapUsed: 0,
          topProcesses: [],
          diskPercent: 20,
          diskUsed: 20,
          diskTotal: 100,
          disks: [],
          netRxSpeed: 0,
          netTxSpeed: 0,
          latencyMs: 5,
          netInterfaces: [],
        },
        companionProbes: {
          vnc: {
            protocol: "vnc",
            port: 5900,
            reachable: true,
            rttMs: 7,
            bannerVerified: true,
            bannerDetail: "RFB 3.8",
            checkedAt: ts,
            tunnelViaHostSsh: true,
          },
        },
        points: [
          { at: ts, cpu: 30, memory: 40, disk: 20, rx: 0, tx: 0 },
        ],
      },
    },
  });

  // Charts view
  writeMonitorPanels([{
    id: "p-rd",
    name: "Mixed",
    description: "",
    hostIds: ["rdp-win", "ssh-comp"],
    view: "charts",
    interval: 5,
    range: 15,
    sort: "manual",
  }]);
  await act(async () => {
    root.render(
      <I18nProvider locale="en">
        <MonitorPanels hosts={[rdpHost, sshHost]} customGroups={[]} onConnect={() => {}} />
      </I18nProvider>,
    );
  });

  const chartsDoc = dom.window.document;
  const rdpCard = chartsDoc.querySelector('[data-monitor-host="rdp-win"]')!;
  assert.ok(rdpCard);
  assert.equal(rdpCard.getAttribute("data-monitor-card-mode"), "probe");
  assert.match(rdpCard.querySelector("[data-monitor-probe-rtt]")!.textContent!, /24 ms/);
  assert.ok(rdpCard.textContent!.includes("RDP (NLA / CredSSP)"));
  assert.ok(rdpCard.textContent!.includes("Online"));
  assert.ok(rdpCard.querySelector('[data-monitor-trend="latencyMs"]'));
  assert.equal(rdpCard.querySelector('[data-monitor-trend="cpu"]'), null);
  assert.equal(rdpCard.querySelector('[data-monitor-trend="memory"]'), null);
  assert.match(
    rdpCard.querySelector('[data-monitor-terminal="rdp-win"]')!.getAttribute("aria-label")!,
    /Open RDP/,
  );

  const sshCard = chartsDoc.querySelector('[data-monitor-host="ssh-comp"]')!;
  assert.ok(sshCard.querySelector('[data-monitor-trend="cpu"]'));
  const compPill = sshCard.querySelector('[data-monitor-companion-pill="vnc"]')!;
  assert.ok(compPill);
  assert.match(compPill.textContent!, /VNC :5900.*7 ms/);

  // Click RDP card to open detail panel and click "Check now" — must call monitorActions.retry without opening SSH login dialog
  await act(async () => {
    (rdpCard.querySelector("button") as HTMLButtonElement).click();
  });
  const detailPanel = chartsDoc.querySelector('[data-section="vault-monitor-detail"]')!;
  assert.ok(detailPanel);
  assert.ok(detailPanel.querySelector("[data-monitor-probe-detail]"));
  const checkNowBtn = [...detailPanel.querySelectorAll("button")].find(
    (b) => b.textContent?.includes("Check now"),
  );
  assert.ok(checkNowBtn);
  await act(async () => {
    checkNowBtn.click();
  });
  assert.deepEqual(retried, [{ id: "rdp-win", creds: undefined }]);
  assert.equal(chartsDoc.querySelector("#monitor-login-password"), null);

  // List view preserves columns with muted "—" placeholders for probe hosts
  writeMonitorPanels([{
    id: "p-rd",
    name: "Mixed",
    description: "",
    hostIds: ["rdp-win", "ssh-comp"],
    view: "list",
    interval: 5,
    range: 15,
    sort: "manual",
  }]);
  await act(async () => {
    root.render(
      <I18nProvider locale="en">
        <MonitorPanels hosts={[rdpHost, sshHost]} customGroups={[]} onConnect={() => {}} />
      </I18nProvider>,
    );
  });
  const rdpRow = chartsDoc.querySelector('tr[data-monitor-host="rdp-win"]')!;
  assert.ok(rdpRow);
  assert.equal(rdpRow.querySelectorAll('[data-monitor-probe-na="true"]').length, 5);
  assert.ok(rdpRow.textContent!.includes("Online"));
  assert.ok(rdpRow.textContent!.includes("RDP (NLA / CredSSP)"));
});
