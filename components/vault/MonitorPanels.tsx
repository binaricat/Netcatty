import React, { useEffect, useId, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Clock3,
  Copy,
  Cpu,
  Gauge,
  Gpu,
  HardDrive,
  LayoutGrid,
  List,
  MemoryStick,
  Pencil,
  Play,
  Plus,
  Server,
  Square,
  Terminal,
  Trash2,
} from "lucide-react";
import { useI18n } from "../../application/i18n/I18nProvider";
import {
  deleteMonitorPanel,
  saveMonitorPanel,
  useMonitorPanels,
} from "../../application/state/monitorPanelsStorage";
import {
  monitorActions,
  useMonitorSnapshot,
} from "../../application/state/monitorRuntimeStore";
import { DEFAULT_MONITOR_INTERVAL, MONITOR_INTERVALS, reorderMonitorHosts, type MonitorPanel } from "../../domain/monitorPanels";
import {
  monitorStateSince,
  type MonitorHostState,
  type MonitorPoint,
} from "../../domain/monitorRuntime";
import type { Host } from "../../domain/models";
import { buildMonitorTrendGeometry, findMonitorChartPoint } from "../../domain/monitorChart";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { ContextMenuItem } from "../ui/context-menu";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { Combobox } from "../ui/combobox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import {
  AsideActionMenu,
  AsideActionMenuItem,
  AsidePanel,
  AsidePanelContent,
  AsidePanelFooter,
} from "../ui/aside-panel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import SelectHostPanel from "../SelectHostPanel";
import { DistroAvatar } from "../DistroAvatar";
import { ResourceBar } from "../systemManager/ResourceBar";
import { MonitorDiskUsage } from "./MonitorDiskUsage";
import { VaultHeaderSearch, VaultPageHeader, vaultHeaderIconButtonClass, vaultHeaderSecondaryButtonClass } from "./VaultPageHeader";
import { toast } from "../ui/toast";
import { TooltipProvider } from "../ui/tooltip";
import { MonitorHostCollection } from "./MonitorHostCollection";
import { MonitorHostLatency, MonitorHostNotes, MonitorHostTags } from "./MonitorHostMetadata";

const emptyMonitorPoints: MonitorPoint[] = [];
const percent = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "--" : `${n.toFixed(1)}%`;
const capacity = (n: number | null | undefined) =>
  n == null
    ? "--"
    : n >= 1024
      ? `${(n / 1024).toFixed(1)} GiB`
      : `${n.toFixed(0)} MiB`;
const rate = (n: number | null | undefined) =>
  n == null
    ? "--"
    : n >= 1048576
      ? `${(n / 1048576).toFixed(1)} MiB/s`
      : `${(n / 1024).toFixed(1)} KiB/s`;

const monitorAsideHeaderClass =
  "relative h-14 py-0 border-b-0 after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-px after:origin-bottom after:[transform:scaleY(.5)] after:bg-border/40 after:content-['']";
const monitorAsideClass = "border-border/30 shadow-[-12px_0_24px_hsl(var(--foreground)/0.04)]";

/** Sparse lines: never bridge a missing sample or invent history before monitoring started. */
export const MonitorTrend = React.memo(function MonitorTrend({
  points,
  field,
  range,
  interval,
  clock,
  label,
  className,
}: {
  points: MonitorPoint[];
  field: "cpu" | "memory" | "rx" | "tx";
  range: number;
  interval: number;
  clock: number;
  label: string;
  className?: string;
}) {
  const gradientId = useId();
  const { resolvedLocale } = useI18n();
  const [hoverAt, setHoverAt] = useState<number | null>(null);
  const { end, start, visible, max, segments } = useMemo(
    () => buildMonitorTrendGeometry(points, field, range, interval, Math.max(Date.now(), clock * 5000)),
    [points, field, range, interval, clock],
  );
  const hovered = hoverAt == null ? undefined : visible.find((p) => p.at === hoverAt);
  const hoveredValue = hovered?.[field];
  const hoverX = hovered ? ((hovered.at - start) / (end - start)) * 300 : 0;
  const hoverY = hoveredValue == null ? 0 : 58 - (Math.min(max, Math.max(0, hoveredValue)) / max) * 54;
  return (
    <div className="relative min-w-0">
      <svg
        role="img"
        aria-label={label}
        viewBox="0 0 300 64"
        preserveAspectRatio="none"
        className={cn("block h-16 w-full cursor-crosshair text-primary", className)}
        data-monitor-trend={field}
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          if (!rect.width) return;
          const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
          const point = findMonitorChartPoint(
            visible,
            field,
            start + fraction * (end - start),
            Math.max(interval * 1250, ((end - start) / rect.width) * 4),
          );
          setHoverAt(point?.at ?? null);
        }}
        onPointerLeave={() => setHoverAt(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity=".20" />
            <stop offset="100%" stopColor="currentColor" stopOpacity=".02" />
          </linearGradient>
        </defs>
        <path
          d="M0 4 H300 M0 31 H300 M0 58 H300"
          className="stroke-border/60"
          strokeWidth=".5"
          strokeDasharray="3 4"
        />
        {segments.map(({ path, firstX, x, y }, i) => (
          <g key={i}>
            <path
              d={`${path} L ${x.toFixed(2)} 58 L ${firstX.toFixed(2)} 58 Z`}
              fill={`url(#${gradientId})`}
            />
            <path
              d={path}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
            <circle cx={x} cy={y} r="2" fill="currentColor" />
          </g>
        ))}
        {hoveredValue != null && (
          <g aria-hidden="true">
            <line x1={hoverX} x2={hoverX} y1="4" y2="58" stroke="currentColor" strokeOpacity=".5" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
            <circle cx={hoverX} cy={hoverY} r="3" fill="currentColor" className="stroke-background" strokeWidth="1.5" />
          </g>
        )}
      </svg>
      {hovered && hoveredValue != null && (
        <div role="tooltip" className="pointer-events-none absolute bottom-full right-0 z-10 mb-1 whitespace-nowrap rounded-md border border-border/40 bg-popover px-2 py-1.5 text-[10px] text-popover-foreground shadow-md">
          <div className="font-medium">{label} · {field === "cpu" || field === "memory" ? `${hoveredValue.toFixed(2)}%` : rate(hoveredValue)}</div>
          <time dateTime={new Date(hovered.at).toISOString()} className="text-muted-foreground">
            {new Date(hovered.at).toLocaleTimeString(resolvedLocale, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </time>
        </div>
      )}
    </div>
  );
});

export function MonitorPanels({
  hosts,
  customGroups,
  onConnect,
}: {
  hosts: Host[];
  customGroups: string[];
  onConnect: (host: Host) => void;
}) {
  const { t } = useI18n();
  const panels = useMonitorPanels();
  const runtime = useMonitorSnapshot();
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [dragging, setDragging] = useState<{ panelId: string; hostId: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [editor, setEditor] = useState<{
    base: MonitorPanel | null;
    draft: MonitorPanel;
  } | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<{ hostId: string; username: string; password: string } | null>(null);
  const [deleting, setDeleting] = useState<MonitorPanel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const panel = panels.find((p) => p.id === selected) ?? panels[0];
  const running = !!panel && runtime.running.includes(panel.id);
  const startEdit = (base: MonitorPanel | null) => {
    setDetail(null);
    setRecovery(null);
    setSelecting(false);
    setError(null);
    setEditor({
      base,
      draft: base
        ? { ...base, hostIds: [...base.hostIds] }
        : {
            id: crypto.randomUUID(),
            name: "",
            description: "",
            hostIds: [],
            view: "charts",
            interval: DEFAULT_MONITOR_INTERVAL,
            range: 15,
            sort: "manual",
          },
    });
  };
  const updateDraft = (patch: Partial<MonitorPanel>) =>
    setEditor((prev) =>
      prev ? { ...prev, draft: { ...prev.draft, ...patch } } : prev,
    );
  const save = async () => {
    if (!editor) return;
    if (!editor.draft.name.trim()) {
      setError("monitor.nameRequired");
      return;
    }
    if (!editor.draft.hostIds.length) {
      setError("monitor.hostRequired");
      return;
    }
    setSaving(true);
    try {
      await saveMonitorPanel(editor.base, editor.draft);
      setSelected(editor.draft.id);
      setEditor(null);
    } catch (e) {
      setError(
        e instanceof Error && e.message.startsWith("monitor.")
          ? e.message
          : "monitor.saveFailed",
      );
    } finally {
      setSaving(false);
    }
  };
  const patchPanel = async (patch: Partial<MonitorPanel>) => {
    if (!panel) return;
    try {
      await saveMonitorPanel(panel, { ...panel, ...patch });
    } catch {
      toast.error(t("monitor.saveFailed"));
    }
  };
  const duplicate = async () => {
    if (!panel) return;
    let name = t("monitor.copyName", { name: panel.name });
    let suffix = 2;
    while (
      panels.some(
        (p) => p.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
      )
    )
      name = `${t("monitor.copyName", { name: panel.name })} ${suffix++}`;
    const copy = { ...panel, id: crypto.randomUUID(), name };
    try {
      await saveMonitorPanel(null, copy);
      setSelected(copy.id);
      setDetail(null);
      setEditor(null);
    } catch {
      toast.error(t("monitor.saveFailed"));
    }
  };
  const hostById = useMemo(
    () => new Map(hosts.map((host) => [host.id, host])),
    [hosts],
  );
  const orderedHostIds = useMemo(() => {
    if (!panel) return [];
    return panel.sort === "manual"
      ? panel.hostIds
      : [...panel.hostIds].sort((a, b) =>
          (hostById.get(a)?.label ?? a).localeCompare(
            hostById.get(b)?.label ?? b,
          ),
        );
  }, [panel, hostById]);
  const rows = useMemo(() => {
    if (!panel) return [];
    const q = search.trim().toLocaleLowerCase();
    const rows = orderedHostIds.map((id) => ({
      id,
      host: hostById.get(id),
      state: monitorStateSince(runtime.hosts[id], runtime.startedAt[panel.id]),
    }));
    return rows.filter(
      ({ host }) =>
        !q ||
        `${host?.label ?? ""} ${host?.hostname ?? ""} ${host?.group ?? ""} ${host?.tags.join(" ") ?? ""} ${host?.notes ?? ""}`
          .toLocaleLowerCase()
          .includes(q),
    );
  }, [panel, orderedHostIds, hostById, runtime, search]);
  const dragProps = (
    hostId: string,
  ): React.HTMLAttributes<HTMLElement> & { "data-monitor-host": string } => ({
    draggable: true,
    "data-monitor-host": hostId,
    onDragStart: (event) => {
      if (!panel) return;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", hostId);
      setDragging({ panelId: panel.id, hostId });
    },
    onDragOver: (event) => {
      if (
        !panel ||
        dragging?.panelId !== panel.id ||
        dragging.hostId === hostId
      )
        return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setDropTarget(hostId);
    },
    onDrop: (event) => {
      if (!panel || dragging?.panelId !== panel.id) return;
      event.preventDefault();
      if (dragging.hostId !== hostId)
        void patchPanel({
          hostIds: reorderMonitorHosts(orderedHostIds, dragging.hostId, hostId),
          sort: "manual",
        });
      setDragging(null);
      setDropTarget(null);
    },
    onDragEnd: () => {
      setDragging(null);
      setDropTarget(null);
    },
  });
  const status = (host: Host | undefined, state?: MonitorHostState) =>
    !host
      ? "missing"
      : !running
        ? "stopped"
        : state?.status === "live" &&
            Date.now() - state.at >
              Math.max(
                5000,
                (panel?.interval ?? DEFAULT_MONITOR_INTERVAL) * 2500,
              )
          ? "stale"
          : (state?.status ?? "queued");
  const stateBadge = (host: Host | undefined, state?: MonitorHostState) => (
    <span
      className={cn(
        "inline-flex min-w-0 max-w-full items-center gap-1.5 whitespace-nowrap text-[10px] shrink-0 font-medium",
        status(host, state) === "live"
          ? "text-emerald-700 dark:text-emerald-400"
          : ["error", "disconnected", "missing"].includes(status(host, state))
            ? "text-destructive"
            : ["login", "stale", "unsupported", "limit"].includes(
                  status(host, state),
                )
              ? "text-amber-700 dark:text-amber-400"
              : "text-muted-foreground",
      )}
    >
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 rounded-full bg-current"
      />
      <span className="truncate">
        {t(`monitor.status.${status(host, state)}`)}
      </span>
    </span>
  );
  const renderMetrics = (
    state: MonitorHostState | undefined,
    large = false,
  ) => {
    const s = state?.stats;
    const memory =
      s?.memTotal && s.memUsed != null ? (s.memUsed / s.memTotal) * 100 : null;
    return (
      <div className={cn("grid grid-cols-2 gap-2", large && "gap-3")}>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Cpu size={13} className="text-sky-600 dark:text-sky-400" />
            {t("monitor.cpu")}
          </div>
          <div className="mt-2 text-xl font-semibold leading-tight tabular-nums text-foreground">
            {percent(s?.cpu)}
          </div>
          <div className="mt-1 min-h-4 text-[10px] text-muted-foreground">
            {s?.cpuCores ? t("monitor.cores", { count: s.cpuCores }) : "--"}
          </div>
          {panel && (
            <MonitorTrend
              clock={Math.floor(runtime.takenAt / 5000)}
              points={state?.points ?? emptyMonitorPoints}
              field="cpu"
              range={panel.range}
              interval={panel.interval}
              label={t("monitor.cpuTrend")}
              className="mt-2 h-14 text-sky-600 dark:text-sky-400"
            />
          )}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <MemoryStick size={13} className="text-emerald-600 dark:text-emerald-400" />
            {t("monitor.memory")}
          </div>
          <div className="mt-2 text-xl font-semibold leading-tight tabular-nums text-foreground">
            {percent(memory)}
          </div>
          <div className="mt-1 min-h-4 text-[10px] text-muted-foreground">
            {capacity(s?.memUsed)} / {capacity(s?.memTotal)}
          </div>
          {panel && (
            <MonitorTrend
              clock={Math.floor(runtime.takenAt / 5000)}
              points={state?.points ?? emptyMonitorPoints}
              field="memory"
              range={panel.range}
              interval={panel.interval}
              label={t("monitor.memoryTrend")}
              className="mt-2 h-14 text-emerald-600 dark:text-emerald-400"
            />
          )}
        </div>
      </div>
    );
  };
  const hostDetail = hosts.find((h) => h.id === detail);
  const detailState = detail && panel ? monitorStateSince(runtime.hosts[detail], runtime.startedAt[panel.id]) : undefined;
  const detailAvailable = status(hostDetail, detailState) === "live";
  useEffect(() => {
    if (detail && !detailAvailable) setDetail(null);
  }, [detail, detailAvailable]);
  return (
    <section
      className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
      data-section="vault-monitor"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col [container-type:inline-size] [container-name:monitor-main]">
        <VaultPageHeader contentClassName="gap-2 overflow-x-auto [scrollbar-width:none]">
          {panel && (
            <>
              <Combobox
                options={panels.map((p) => ({
                  value: p.id,
                  label: p.name,
                  sublabel: p.description,
                }))}
                value={panel.id}
                onValueChange={(id) => {
                  setSelected(id);
                  setDetail(null);
                  setEditor(null);
                }}
                triggerClassName="w-56 min-w-24 shrink"
                clearable={false}
                ariaLabel={t("monitor.choosePanel")}
              />
              <Button
                variant="ghost"
                size="icon"
                className={cn(vaultHeaderIconButtonClass, "shrink-0")}
                aria-label={t("monitor.edit")}
                onClick={() => startEdit(panel)}
              >
                <Pencil size={15} />
              </Button>
              <AsideActionMenu triggerClassName={cn(vaultHeaderIconButtonClass, "shrink-0 inline-flex items-center justify-center")} ariaLabel={t("monitor.actions")}>
                <AsideActionMenuItem
                  onClick={() => {
                    void duplicate();
                  }}
                >
                  <Copy size={14} className="mr-2" />
                  {t("monitor.copy")}
                </AsideActionMenuItem>
                <AsideActionMenuItem
                  variant="destructive"
                  onClick={() => setDeleting(panel)}
                >
                  <Trash2 size={14} className="mr-2" />
                  {t("monitor.delete")}
                </AsideActionMenuItem>
                {!!runtime.count && (
                  <AsideActionMenuItem onClick={monitorActions.stopAll}>
                    <Square size={14} className="mr-2" />
                    {t("monitor.stopAll")}
                  </AsideActionMenuItem>
                )}
              </AsideActionMenu>
            </>
          )}
          <div className="min-w-0 flex-1" />
          {panel && (
            <Button
              variant="secondary"
              size="sm"
              className={cn(vaultHeaderSecondaryButtonClass, "shrink-0")}
              aria-label={t(running ? "monitor.stop" : "monitor.start")}
              title={t(running ? "monitor.stop" : "monitor.start")}
              onClick={() =>
                running
                  ? monitorActions.stop(panel.id)
                  : monitorActions.start(panel.id)
              }
            >
              {running ? <Square size={13} /> : <Play size={13} />}
              <span className="monitor-header-action-label">{t(running ? "monitor.stop" : "monitor.start")}</span>
            </Button>
          )}
          <Button
            variant="secondary"
            className={cn(vaultHeaderSecondaryButtonClass, "shrink-0")}
            aria-label={t("monitor.create")}
            title={t("monitor.create")}
            onClick={() => startEdit(null)}
          >
            <Plus size={14} />
            <span className="monitor-header-action-label">{t("monitor.create")}</span>
          </Button>
        </VaultPageHeader>
        {runtime.unavailable && (
          <p
            role="alert"
            className="border-b border-border/40 px-4 py-3 text-xs text-destructive"
          >
            {t("monitor.unavailable")}
          </p>
        )}
          {!panel ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
              <Gauge size={36} className="text-muted-foreground" />
              <h2 className="font-semibold">{t("monitor.empty")}</h2>
              <p className="max-w-sm text-sm text-muted-foreground">
                {t("monitor.emptyHint")}
              </p>
              <Button onClick={() => startEdit(null)}>
                {t("monitor.createFirst")}
              </Button>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 px-4 py-2">
                <div className="flex h-8 rounded-md bg-muted/50 p-0.5">
                  {(["list", "charts"] as const).map((view) => (
                    <Button
                      key={view}
                      size="sm"
                      variant={panel.view === view ? "secondary" : "ghost"}
                      className="h-7 gap-1.5"
                      onClick={() => {
                        void patchPanel({ view });
                      }}
                    >
                      {view === "list" ? (
                        <List size={14} />
                      ) : (
                        <LayoutGrid size={14} />
                      )}
                      {t(`monitor.${view}`)}
                    </Button>
                  ))}
                </div>
                <VaultHeaderSearch
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t("monitor.search")}
                  className="min-w-36 flex-1"
                  inputClassName="h-8 text-xs"
                />
                <Select
                  value={String(panel.interval)}
                  onValueChange={(v) => {
                    void patchPanel({
                      interval: Number(v) as MonitorPanel["interval"],
                    });
                  }}
                >
                  <SelectTrigger
                    className="h-8 w-auto text-xs"
                    aria-label={t("monitor.interval")}
                  >
                    <SelectValue>{t("monitor.seconds", { count: panel.interval })}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {MONITOR_INTERVALS.filter((v) => v >= 3).map((v) => (
                      <SelectItem key={v} value={String(v)}>
                        {t("monitor.seconds", { count: v })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={String(panel.range)}
                  onValueChange={(v) => {
                    void patchPanel({
                      range: Number(v) as MonitorPanel["range"],
                    });
                  }}
                >
                  <SelectTrigger
                    className="h-8 w-auto text-xs"
                    aria-label={t("monitor.range")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[5, 15, 30].map((v) => (
                      <SelectItem key={v} value={String(v)}>
                        {t("monitor.minutes", { count: v })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={panel.sort}
                  onValueChange={(v) => {
                    void patchPanel({ sort: v as MonitorPanel["sort"] });
                  }}
                >
                  <SelectTrigger
                    className="h-8 w-auto text-xs"
                    aria-label={t("monitor.sort")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {["manual", "name"].map((v) => (
                      <SelectItem key={v} value={v}>
                        {t(`monitor.sort.${v}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {!rows.length ? (
                <div className="flex-1 overflow-auto p-12 text-center text-sm text-muted-foreground">
                  {t("monitor.noMatches")}
                </div>
              ) : (
                <TooltipProvider delayDuration={180}>
                  <MonitorHostCollection
                    items={rows}
                    view={panel.view}
                    layoutKey={`${panel.id}:${panel.view}:${search}`}
                    pinnedId={
                      dragging?.panelId === panel.id ? dragging.hostId : undefined
                    }
                    renderMenu={({ id, host, state }) => (
                      <>
                        <ContextMenuItem disabled={!host} onSelect={() => host && onConnect(host)}>
                          {t("monitor.openTerminal")}
                        </ContextMenuItem>
                        {host && running && ["login", "error", "disconnected"].includes(status(host, state)) && (
                          <ContextMenuItem data-monitor-retry={id} onSelect={() => setRecovery({hostId: id, username: host.username ?? "", password: ""})}>
                            {t("monitor.retry")}
                          </ContextMenuItem>
                        )}
                      </>
                    )}
                    rowProps={({ id, host, state }) => ({
                      ...dragProps(id),
                      className: cn(
                        "group cursor-default [&>td]:bg-card/70 hover:[&>td]:bg-card [&>td:first-child]:rounded-l-xl [&>td]:min-w-0 [&>td]:px-3 [&>td]:py-3 [&>td]:flex [&>td]:items-center",
                        dragging?.panelId === panel.id &&
                          dragging.hostId === id &&
                          "cursor-grabbing opacity-40",
                        dropTarget === id && "[&>td]:bg-accent",
                        status(host, state) !== "live" && "text-muted-foreground opacity-50",
                      ),
                    })}
                    renderCard={({ id, host, state }) => (
                      <article
                        {...dragProps(id)}
                        className={cn(
                          "relative h-full min-w-0 overflow-hidden rounded-xl bg-card/70 shadow-sm shadow-black/[0.02] transition-colors hover:bg-card",
                          dragging?.panelId === panel.id &&
                            dragging.hostId === id &&
                            "cursor-grabbing opacity-40",
                          dropTarget === id && "bg-accent",
                          status(host, state) !== "live" && "opacity-50",
                        )}
                      >
                        <button
                          type="button"
                          className="flex h-full w-full min-w-0 cursor-default flex-col p-4 text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary"
                          aria-disabled={status(host, state) !== "live"}
                          onClick={() => {
                            if (status(host, state) !== "live") return;
                            setEditor(null);
                            setDetail(id);
                          }}
                        >
                          <div className="mb-2 flex w-full min-w-0 items-center gap-3 pr-7">
                            {host ? (
                              <DistroAvatar
                                host={host}
                                fallback={host.label}
                                size="log"
                              />
                            ) : (
                              <Server
                                size={24}
                                className="shrink-0 text-muted-foreground"
                              />
                            )}
                            <div className="min-w-0 flex-1">
                              <h3 className="truncate text-sm font-semibold text-foreground">
                                {host?.label ?? t("monitor.missingHost")}
                              </h3>
                              <p className="truncate text-xs text-muted-foreground">
                                {host?.hostname ?? id}
                              </p>
                            </div>
                          </div>
                          <div className="mb-2 flex h-5 w-full min-w-0 items-center gap-2">
                            <MonitorHostLatency value={state?.stats?.latencyMs} responseValue={state?.stats?.responseLatencyMs} />
                            <div className="min-w-0 flex-1">
                              <MonitorHostTags tags={host?.tags} />
                            </div>
                            <div className="min-w-0 max-w-[40%]">
                              {stateBadge(host, state)}
                            </div>
                          </div>
                          <div
                            className={cn(
                              "w-full min-w-0",
                              status(host, state) !== "live" && "opacity-60",
                            )}
                          >
                            {renderMetrics(state)}
                            <div className="mt-3">
                              <div className="mb-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                                <HardDrive
                                  size={13}
                                  className="text-amber-600 dark:text-amber-400"
                                />
                                <span>{t("monitor.disks")}</span>
                              </div>
                              <MonitorDiskUsage stats={state?.stats} limit={2} />
                            </div>
                            <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] tabular-nums">
                              <span className="flex items-center gap-1.5 py-1">
                                <ArrowDown
                                  size={13}
                                  className="shrink-0 text-sky-600 dark:text-sky-400"
                                />
                                {rate(
                                  state?.stats?.networkReady
                                    ? state.stats.netRxSpeed
                                    : null,
                                )}
                              </span>
                              <span className="flex items-center gap-1.5 py-1">
                                <ArrowUp
                                  size={13}
                                  className="shrink-0 text-violet-600 dark:text-violet-400"
                                />
                                {rate(
                                  state?.stats?.networkReady
                                    ? state.stats.netTxSpeed
                                    : null,
                                )}
                              </span>
                            </div>
                          </div>
                          <div className="mt-auto flex w-full min-w-0 items-center gap-2 pt-2 text-[10px] text-muted-foreground">
                            <div className="min-w-0 flex-1">
                              <MonitorHostNotes notes={host?.notes} />
                            </div>
                            <span className="inline-flex shrink-0 items-center gap-1">
                              <Clock3 size={11} />
                              {state?.at
                                ? new Date(state.at).toLocaleTimeString()
                                : t("monitor.noSamples")}
                            </span>
                          </div>
                        </button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="absolute right-3 top-3 h-7 w-7 text-muted-foreground"
                          data-monitor-terminal={id}
                          aria-label={`${t("monitor.openTerminal")}: ${host?.label ?? t("monitor.missingHost")}`}
                          title={t("monitor.openTerminal")}
                          disabled={!host}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (host) onConnect(host);
                          }}
                        >
                          <Terminal size={14} />
                        </Button>
                      </article>
                    )}
                    renderCells={({ id, host, state }) => ({
                      host: (<td>
                          <button
                            type="button"
                            className="flex w-full min-w-0 items-center gap-2.5 text-left aria-disabled:no-underline hover:underline"
                            aria-disabled={status(host, state) !== "live"}
                            onClick={() => {
                              if (status(host, state) !== "live") return;
                              setEditor(null);
                              setDetail(id);
                            }}
                          >
                            {host ? (
                              <DistroAvatar
                                host={host}
                                fallback={host.label}
                                size="md"
                              />
                            ) : (
                              <Server
                                size={24}
                                className="shrink-0 text-muted-foreground"
                              />
                            )}
                            <div className="min-w-0">
                              <div className="truncate font-medium">
                                {host?.label ?? t("monitor.missingHost")}
                              </div>
                              <div className="truncate text-[10px] text-muted-foreground">
                                {host?.hostname ?? id}
                              </div>
                            </div>
                          </button>
                        </td>),
                      latency: (<td>
                          <MonitorHostLatency value={state?.stats?.latencyMs} responseValue={state?.stats?.responseLatencyMs} />
                        </td>),
                      tags: (<td>
                          <MonitorHostTags tags={host?.tags} />
                        </td>),
                      notes: (<td>
                          <div className="min-w-0 w-full">
                            <MonitorHostNotes notes={host?.notes} focusable />
                          </div>
                        </td>),
                      cpu: (<td className="tabular-nums">
                          <ResourceBar
                            className="w-full"
                            label=""
                            value={state?.stats?.cpu}
                          />
                        </td>),
                      memory: (<td className="tabular-nums">
                          <ResourceBar
                            className="w-full"
                            label=""
                            value={
                              state?.stats?.memTotal &&
                              state.stats.memUsed != null
                                ? (state.stats.memUsed / state.stats.memTotal) *
                                  100
                                : null
                            }
                          />
                        </td>),
                      disks: (<td>
                          <div className="w-full min-w-0">
                            <MonitorDiskUsage stats={state?.stats} />
                          </div>
                        </td>),
                      network: (<td
                          data-monitor-cell="network"
                          className="tabular-nums whitespace-nowrap"
                        >
                          <div>
                            <div className="flex items-center gap-1.5">
                              <ArrowDown
                                size={13}
                                className="shrink-0 text-sky-600 dark:text-sky-400"
                              />
                              <span className="sr-only">
                                {t("monitor.download")}:{" "}
                              </span>
                              {rate(
                                state?.stats?.networkReady
                                  ? state.stats.netRxSpeed
                                  : null,
                              )}
                            </div>
                            <div className="flex items-center gap-1.5">
                              <ArrowUp
                                size={13}
                                className="shrink-0 text-violet-600 dark:text-violet-400"
                              />
                              <span className="sr-only">
                                {t("monitor.upload")}:{" "}
                              </span>
                              {rate(
                                state?.stats?.networkReady
                                  ? state.stats.netTxSpeed
                                  : null,
                              )}
                            </div>
                          </div>
                        </td>),
                      updated: (<td className="whitespace-nowrap tabular-nums">
                          {state?.at
                            ? new Date(state.at).toLocaleTimeString()
                            : "--"}
                        </td>),
                      status: (<td>{stateBadge(host, state)}</td>),
                      terminal: (<td className="sticky right-0 z-10 justify-center !bg-background before:pointer-events-none before:absolute before:inset-0 before:rounded-r-xl before:bg-card/70 group-hover:before:bg-card">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="relative h-7 w-7 text-muted-foreground"
                            data-monitor-terminal={id}
                            aria-label={`${t("monitor.openTerminal")}: ${host?.label ?? t("monitor.missingHost")}`}
                            title={t("monitor.openTerminal")}
                            disabled={!host}
                            onClick={(event) => {
                              event.stopPropagation();
                              if (host) onConnect(host);
                            }}
                          >
                            <Terminal size={14} />
                          </Button>
                        </td>)
                    })}
                  />
                </TooltipProvider>
              )}
            </>
          )}
        </div>
        {editor && !selecting && (
          <AsidePanel
            open
            onClose={() => setEditor(null)}
            title={t(editor.base ? "monitor.edit" : "monitor.create")}
            layout="inline"
            resizable
            resizeAriaLabel={t("vault.panel.resizeWidth")}
            headerClassName={monitorAsideHeaderClass}
            width="w-[380px]"
            className={monitorAsideClass}
          >
            <AsidePanelContent>
              <div className="space-y-2">
                <Label htmlFor="monitor-name">{t("monitor.name")}</Label>
                <Input
                  id="monitor-name"
                  autoFocus
                  maxLength={120}
                  value={editor.draft.name}
                  onChange={(e) => updateDraft({ name: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="monitor-description">
                  {t("monitor.description")}
                </Label>
                <Textarea
                  id="monitor-description"
                  maxLength={1000}
                  value={editor.draft.description}
                  onChange={(e) => updateDraft({ description: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>{t("monitor.hosts")}</Label>
                <Button
                  variant="outline"
                  className="w-full justify-between"
                  aria-label={t("monitor.chooseHosts")}
                  onClick={() => setSelecting(true)}
                >
                  {t("monitor.selectedCount", {
                    count: editor.draft.hostIds.length,
                  })}
                  <Plus size={14} />
                </Button>
                <p className="text-xs text-muted-foreground">
                  {t("monitor.selectionHint")}
                </p>
              </div>
              <div className="space-y-2">
                {editor.draft.hostIds.map((id, index) => (
                  <div
                    key={id}
                    className="flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-xs"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {hosts.find((h) => h.id === id)?.label ??
                        t("monitor.missingHost")}
                    </span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      disabled={!index}
                      aria-label={t("monitor.moveUp")}
                      onClick={() => {
                        const ids = [...editor.draft.hostIds];
                        [ids[index - 1], ids[index]] = [
                          ids[index],
                          ids[index - 1],
                        ];
                        updateDraft({ hostIds: ids });
                      }}
                    >
                      <ArrowUp size={13} />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      aria-label={t("monitor.removeHost")}
                      onClick={() =>
                        updateDraft({
                          hostIds: editor.draft.hostIds.filter((h) => h !== id),
                        })
                      }
                    >
                      <Trash2 size={13} />
                    </Button>
                  </div>
                ))}
              </div>
              <div className="space-y-2">
                <Label>{t("monitor.defaultView")}</Label>
                <Select
                  value={editor.draft.view}
                  onValueChange={(v) =>
                    updateDraft({ view: v as MonitorPanel["view"] })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="list">{t("monitor.list")}</SelectItem>
                    <SelectItem value="charts">
                      {t("monitor.charts")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("monitor.saveHint")}
              </p>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {t(error)}
                </p>
              )}
            </AsidePanelContent>
            <AsidePanelFooter>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => setEditor(null)}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  className="flex-1"
                  disabled={saving}
                  onClick={() => {
                    void save();
                  }}
                >
                  {t("common.save")}
                </Button>
              </div>
            </AsidePanelFooter>
          </AsidePanel>
        )}
        {editor && selecting && (
          <SelectHostPanel
            hosts={hosts}
            customGroups={customGroups}
            selectedHostIds={editor.draft.hostIds}
            multiSelect
            onSelect={() => {}}
            onSelectionChange={(hostIds) => updateDraft({ hostIds })}
            onBack={() => setSelecting(false)}
            onClose={() => {
              setSelecting(false);
              setEditor(null);
            }}
            onContinue={() => setSelecting(false)}
            title={t("monitor.chooseHosts")}
            subtitle={t("monitor.selectionHint")}
            layout="inline"
            resizable
            resizeAriaLabel={t("vault.panel.resizeWidth")}
            headerClassName={monitorAsideHeaderClass}
            className={monitorAsideClass}
          />
        )}
        {detail && detailAvailable && (
          <AsidePanel
            dataSection="vault-monitor-detail"
            open
            onClose={() => setDetail(null)}
            title={hostDetail?.label ?? t("monitor.missingHost")}
            subtitle={hostDetail?.hostname}
            layout="inline"
            resizable
            resizeAriaLabel={t("vault.panel.resizeWidth")}
            headerClassName={monitorAsideHeaderClass}
            width="w-[380px]"
            className={monitorAsideClass}
          >
            <AsidePanelContent scrollMode="native">
              <div className="flex items-center gap-3">
                {hostDetail && <DistroAvatar host={hostDetail} fallback={hostDetail.label} size="lg" />}
                <div className="min-w-0 flex-1">
                  <div className="mb-1 truncate text-xs text-muted-foreground">{hostDetail?.hostname ?? detail}</div>
                  {stateBadge(hostDetail, detailState)}
                </div>
              </div>
              {renderMetrics(detailState, true)}
              {detailState?.stats && (
                detailState.stats.gpu != null ||
                detailState.stats.gpuName ||
                (detailState.stats.gpuMemTotal ?? 0) > 0
              ) && (
                <section className="space-y-3" data-monitor-gpu>
                  <h3 className="flex items-center gap-1.5 text-sm font-medium">
                    <Gpu size={15} className="text-muted-foreground" />
                    {t("systemManager.tabs.gpu")}
                  </h3>
                  {detailState.stats.gpuName && (
                    <p className="break-words text-xs text-muted-foreground">
                      {detailState.stats.gpuName}
                    </p>
                  )}
                  <div className="space-y-1.5">
                    <p className="text-[11px] text-muted-foreground">{t("systemManager.gpu.util")}</p>
                    <ResourceBar label="" value={detailState.stats.gpu} />
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex justify-between gap-2 text-[11px] text-muted-foreground">
                      <span>{t("systemManager.gpu.memory")}</span>
                      <span className="tabular-nums">
                        {capacity(detailState.stats.gpuMemUsed)} / {capacity(detailState.stats.gpuMemTotal)}
                      </span>
                    </div>
                    <ResourceBar label="" value={
                      detailState.stats.gpuMemUsed != null && (detailState.stats.gpuMemTotal ?? 0) > 0
                        ? detailState.stats.gpuMemUsed / detailState.stats.gpuMemTotal! * 100
                        : null
                    } />
                  </div>
                </section>
              )}
              <p className="text-xs text-muted-foreground">
                {t("monitor.observed", {
                  count: detailState?.points.length
                    ? Math.floor(
                        (Date.now() - detailState.points[0].at) / 60000,
                      )
                    : 0,
                })}
              </p>
              <div className="space-y-2">
                <h3 className="text-sm font-medium">{t("monitor.network")}</h3>
                <div className="flex justify-between text-xs">
                  <span>
                    ↓{" "}
                    {rate(
                      detailState?.stats?.networkReady
                        ? detailState.stats.netRxSpeed
                        : null,
                    )}
                  </span>
                  <span>
                    ↑{" "}
                    {rate(
                      detailState?.stats?.networkReady
                        ? detailState.stats.netTxSpeed
                        : null,
                    )}
                  </span>
                </div>
                {panel && (
                  <>
                    <MonitorTrend
                      clock={Math.floor(runtime.takenAt / 5000)}
                      points={detailState?.points ?? emptyMonitorPoints}
                      field="rx"
                      range={panel.range}
                      interval={panel.interval}
                      label={t("monitor.downloadTrend")}
                    />
                    <MonitorTrend
                      clock={Math.floor(runtime.takenAt / 5000)}
                      points={detailState?.points ?? emptyMonitorPoints}
                      field="tx"
                      range={panel.range}
                      interval={panel.interval}
                      label={t("monitor.uploadTrend")}
                    />
                  </>
                )}
                {detailState?.stats?.netInterfaces.map((iface) => (
                  <div
                    key={iface.name}
                    className="flex flex-wrap justify-between gap-2 text-xs"
                  >
                    <span>{iface.name}</span>
                    <span>
                      ↓{" "}
                      {rate(
                        detailState.stats?.networkReady ? iface.rxSpeed : null,
                      )}{" "}
                      ↑{" "}
                      {rate(
                        detailState.stats?.networkReady ? iface.txSpeed : null,
                      )}
                    </span>
                  </div>
                ))}
              </div>
              <div className="space-y-2">
                <h3 className="text-sm font-medium">{t("monitor.disks")}</h3>
                {detailState?.stats?.disks.map((d) => (
                  <div key={d.mountPoint} className="text-xs">
                    <div className="flex justify-between">
                      <span className="break-all">{d.mountPoint}</span>
                      <span
                        className={d.percent >= 90 ? "text-destructive" : ""}
                      >
                        {percent(d.percent)}
                      </span>
                    </div>
                    <p className="text-muted-foreground">
                      {d.used.toFixed(1)} / {d.total.toFixed(1)} GiB
                    </p>
                  </div>
                ))}
              </div>
              <div className="space-y-1 text-xs text-muted-foreground">
                <h3 className="font-medium text-foreground">
                  {t("monitor.system")}
                </h3>
                <p>{detailState?.stats?.osName ?? "--"}</p>
                <p>{detailState?.stats?.kernelRelease ?? "--"}</p>
                <p>{detailState?.stats?.hostname ?? "--"}</p>
              </div>
            </AsidePanelContent>
            <AsidePanelFooter>
              <Button
                className="w-full gap-2"
                disabled={!hostDetail}
                onClick={() => hostDetail && onConnect(hostDetail)}
              >
                <Terminal size={14} />
                {t("monitor.openTerminal")}
              </Button>
            </AsidePanelFooter>
          </AsidePanel>
        )}
      <Dialog open={!!recovery} onOpenChange={(open) => !open && setRecovery(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("monitor.retry")}</DialogTitle>
            <DialogDescription>{t("monitor.loginHint")}</DialogDescription>
          </DialogHeader>
          <form onSubmit={(event) => {
            event.preventDefault();
            if (!recovery) return;
            monitorActions.retry(recovery.hostId, recovery.password ? {username: recovery.username, password: recovery.password} : undefined);
            setRecovery(null);
          }} className="space-y-4">
            <p className="truncate text-sm font-medium">{hostById.get(recovery?.hostId ?? "")?.label}</p>
            <div className="space-y-2">
              <Label htmlFor="monitor-login-user">{t("monitor.username")}</Label>
              <Input id="monitor-login-user" autoComplete="off" value={recovery?.username ?? ""} onChange={(event) => setRecovery(previous => previous && {...previous, username: event.target.value})} />
              <Label htmlFor="monitor-login-password">{t("monitor.password")}</Label>
              <Input id="monitor-login-password" type="password" autoComplete="new-password" value={recovery?.password ?? ""} onChange={(event) => setRecovery(previous => previous && {...previous, password: event.target.value})} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRecovery(null)}>{t("common.cancel")}</Button>
              <Button type="submit">{t("monitor.retry")}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("monitor.delete")}</DialogTitle>
            <DialogDescription>
              {t("monitor.deleteHint", { name: deleting?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!deleting) return;
                void deleteMonitorPanel(deleting.id)
                  .then(() => {
                    monitorActions.stop(deleting.id);
                    setDeleting(null);
                    setDetail(null);
                    setEditor(null);
                  })
                  .catch(() => toast.error(t("monitor.saveFailed")));
              }}
            >
              {t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
