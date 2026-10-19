import React from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../application/i18n/I18nProvider";
import { writeMonitorPanels } from "../../application/state/monitorPanelsStorage";
import {
  monitorActions,
  publishMonitorSnapshot,
} from "../../application/state/monitorRuntimeStore";
import { MonitorPanels } from "../../components/vault/MonitorPanels";
import type { Host } from "../../domain/models";
import type { MonitorSnapshot } from "../../domain/monitorRuntime";
import "../../index.css";

const tokens = {
  background: "210 25% 18%",
  foreground: "210 20% 90%",
  card: "210 23% 21%",
  secondary: "210 20% 24%",
  muted: "210 20% 22%",
  "muted-foreground": "210 15% 65%",
  border: "210 20% 30%",
  primary: "170 70% 42%",
  "primary-foreground": "210 20% 12%",
  popover: "210 25% 20%",
  "popover-foreground": "210 20% 90%",
  destructive: "0 70% 60%",
  input: "210 20% 30%",
  ring: "170 70% 42%",
};
for (const [key, value] of Object.entries(tokens))
  document.documentElement.style.setProperty(`--${key}`, value);
document.documentElement.classList.add("dark");
document.documentElement.style.setProperty("--radius", "8px");
const root = createRoot(document.getElementById("root")!);
let connections: string[] = [];
let retries: {
  id: string;
  credentials?: { username: string; password: string };
}[] = [];
monitorActions.retry = (id, credentials) => {
  retries.push({ id, credentials });
};
let revision = 0;
let latestSnapshot: MonitorSnapshot;
function seed(
  count = 2,
  view: "list" | "charts" = "charts",
  locale = "zh-CN",
  pointCount = 12,
) {
  const now = Date.now();
  const hosts: Host[] = Array.from({ length: count }, (_, i) => ({
    id: `host-${i}`,
    label: `Production server ${String(i + 1).padStart(4, "0")}`,
    hostname: `10.24.${Math.floor(i / 250)}.${(i % 250) + 1}`,
    username: "fixture",
    port: 22,
    os: "linux",
    distro: "ubuntu",
    group: "Production",
    tags:
      i === 1
        ? []
        : [
            "production",
            "database",
            "critical",
            "east-region",
            "long-tag-value-for-overflow",
          ],
    notes:
      i === 1
        ? ""
        : "Primary database cluster. Contact the on-call engineer before restarting.\nMaintenance window: Sunday 02:00–04:00.",
    createdAt: 1,
  }));
  writeMonitorPanels([
    {
      id: "fixture",
      name: "Fleet overview",
      description: "",
      hostIds: hosts.map((h) => h.id),
      view,
      interval: 5,
      range: 15,
      sort: "manual",
    },
  ]);
  const snapshot: MonitorSnapshot = {
    historyMode: "replace",
    runtimeId: "monitor-ui-fixture",
    epoch: now,
    takenAt: now,
    running: ["fixture"],
    count: 1,
    hostCount: count,
    activeSessions: [],
    startedAt: { fixture: now - Math.max(60000, pointCount * 1000) },
    hosts: Object.fromEntries(
      hosts.map((host, i) => [
        host.id,
        {
          historyId: host.id,
          status: "live",
          at: now,
          stats: {
            cpuPerCore: [],
            memFree: 12288,
            memBuffers: 0,
            memCached: 0,
            swapTotal: 0,
            swapUsed: 0,
            topProcesses: [],
            netInterfaces: [],
            cpu: 23 + (i % 60),
            cpuCores: 8,
            memUsed: 4096,
            memTotal: 16384,
            diskPercent: 35,
            diskUsed: 35,
            diskTotal: 100,
            disks: Array.from({ length: i === 2 ? 10 : 2 }, (_, j) => ({
              mountPoint: j ? `/data-${j}` : "/",
              used: 35,
              total: 100 + j * 50,
              percent: 35,
            })),
            netRxSpeed: 240000,
            netTxSpeed: 72000,
            networkReady: true,
            latencyMs:
              i === 1 || i === 5
                ? null
                : i === 2
                  ? 180
                  : i === 3
                    ? 450
                    : i === 4
                      ? 0
                      : 12 + (i % 30),
            responseLatencyMs: i === 5 ? 145 : null,
            gpu: i === 0 ? 45 : i === 2 ? 0 : null,
            gpuName:
              i === 0
                ? "NVIDIA GeForce RTX 4090"
                : i === 2
                  ? "NVIDIA Tesla T4"
                  : null,
            gpuMemUsed: i === 0 ? 8192 : i === 2 ? 0 : null,
            gpuMemTotal: i === 0 ? 24576 : i === 2 ? 16384 : null,
          },
          points: Array.from({ length: pointCount }, (_, j) => ({
            at: now - (pointCount - 1 - j) * (pointCount === 12 ? 5000 : 1000),
            cpu: 20 + ((i + j) % 40),
            memory: 25,
            disk: 35,
            rx: 200000 + j * 1000,
            tx: 70000 + j * 800,
          })),
        },
      ]),
    ),
  };
  latestSnapshot = snapshot;
  publishMonitorSnapshot(snapshot);
  connections = [];
  retries = [];
  root.render(
    <I18nProvider locale={locale}>
      <div className="flex h-screen min-w-0 bg-background text-foreground">
        <MonitorPanels
          key={++revision}
          hosts={hosts}
          customGroups={["Production"]}
          onConnect={(host) => {
            connections.push(host.id);
          }}
        />
      </div>
    </I18nProvider>,
  );
}
Object.assign(window, {
  monitorFixture: {
    seed,
    connections: () => connections,
    retries: () => retries,
    status: (id: string, status: string, age = 0) => {
      latestSnapshot = {
        ...latestSnapshot,
        takenAt: Date.now(),
        hosts: {
          ...latestSnapshot.hosts,
          [id]: {
            ...latestSnapshot.hosts[id],
            at: Date.now() - age,
            status: status as MonitorSnapshot["hosts"][string]["status"],
          },
        },
      };
      publishMonitorSnapshot(latestSnapshot);
    },
    refresh: () => {
      latestSnapshot = {
        ...latestSnapshot,
        takenAt: Date.now(),
        hosts: Object.fromEntries(
          Object.entries(latestSnapshot.hosts).map(([id, state]) => [
            id,
            { ...state, at: Date.now(), points: [...state.points] },
          ]),
        ),
      };
      publishMonitorSnapshot(latestSnapshot);
    },
  },
});
seed(Number(new URLSearchParams(location.search).get("count")) || 2);
