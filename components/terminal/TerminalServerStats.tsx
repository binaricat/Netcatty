import React from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Cpu, HardDrive, MemoryStick } from 'lucide-react';

import { useI18n } from '../../application/i18n/I18nProvider';
import { cn } from '../../lib/utils';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../ui/hover-card';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { formatNetSpeed } from './terminalHelpers';
import { useServerStats } from './hooks/useServerStats';
import { usePaneVisible } from './paneVisibilityStore';

interface TerminalServerStatsProps {
  sessionId: string;
  enabled: boolean;
  refreshInterval: number;
  isSupportedOs: boolean;
  isConnected: boolean;
}

/**
 * Self-contained server-stats (CPU / Memory / Disk / Network) indicator.
 *
 * Owns the `useServerStats` polling itself so the periodic (~5s) stats refresh
 * only re-renders this small widget — previously the hook lived at the top of
 * <Terminal> and `serverStats` was threaded through the giant TerminalView ctx,
 * so every refresh re-rendered the whole terminal subtree (~45ms each, even
 * while idle).
 */
export const TerminalServerStats: React.FC<TerminalServerStatsProps> = ({
  sessionId,
  enabled,
  refreshInterval,
  isSupportedOs,
  isConnected,
}) => {
  const { t } = useI18n();
  const isVisible = usePaneVisible(sessionId);
  const { stats: serverStats } = useServerStats({
    sessionId,
    enabled,
    refreshInterval,
    isSupportedOs,
    isConnected,
    isVisible,
  });

  if (!enabled || !isConnected || !serverStats.lastUpdated) return null;

  return (
              <div className="terminal-server-stats flex items-center gap-2 ml-1 text-[10px] opacity-80 flex-nowrap overflow-hidden min-w-0 shrink">
                {/* CPU with HoverCard for per-core details */}
                <HoverCard openDelay={200} closeDelay={100}>
                  <HoverCardTrigger asChild>
                    <button
                      className="flex items-center gap-0.5 hover:opacity-100 opacity-80 transition-opacity cursor-pointer min-w-0 shrink"
                      aria-label={t("terminal.serverStats.cpu")}
                    >
                      <Cpu size={10} className="flex-shrink-0" />
                      <span className="truncate">
                        {serverStats.cpu !== null ? `${serverStats.cpu}%` : '--'}
                        {serverStats.cpuCores !== null && ` (${serverStats.cpuCores}C)`}
                      </span>
                    </button>
                  </HoverCardTrigger>
                  <HoverCardContent
                    className="w-auto p-3"
                    side="bottom"
                    align="start"
                    sideOffset={8}
                  >
                    <div className="text-xs space-y-2">
                      <div className="font-medium text-sm mb-2">{t("terminal.serverStats.cpuCores")}</div>
                      {serverStats.cpuPerCore.length > 0 ? (
                        <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${Math.min(4, serverStats.cpuPerCore.length)}, 1fr)` }}>
                          {serverStats.cpuPerCore.map((usage, index) => (
                            <div key={index} className="flex flex-col items-center gap-1 min-w-[48px]">
                              <div className="text-[10px] text-muted-foreground">Core {index}</div>
                              <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
                                <div
                                  className={cn(
                                    "h-full rounded-full transition-all",
                                    usage >= 90 ? "bg-red-500" : usage >= 70 ? "bg-amber-500" : "bg-emerald-500"
                                  )}
                                  style={{ width: `${usage}%` }}
                                />
                              </div>
                              <div className={cn(
                                "text-[11px] font-medium",
                                usage >= 90 ? "text-red-400" : usage >= 70 ? "text-amber-400" : "text-emerald-400"
                              )}>
                                {usage}%
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : serverStats.cpu !== null ? (
                        <div className="flex flex-col gap-1.5 min-w-[160px]">
                          <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                            <div
                              className={cn(
                                "h-full rounded-full transition-all",
                                serverStats.cpu >= 90 ? "bg-red-500" : serverStats.cpu >= 70 ? "bg-amber-500" : "bg-emerald-500"
                              )}
                              style={{ width: `${serverStats.cpu}%` }}
                            />
                          </div>
                          <div className={cn(
                            "text-center text-[11px] font-medium",
                            serverStats.cpu >= 90 ? "text-red-400" : serverStats.cpu >= 70 ? "text-amber-400" : "text-emerald-400"
                          )}>
                            {serverStats.cpu}% · {serverStats.cpuCores ?? '?'} cores
                          </div>
                        </div>
                      ) : (
                        <div className="text-muted-foreground">{t("terminal.serverStats.noData")}</div>
                      )}
                    </div>
                  </HoverCardContent>
                </HoverCard>
                {/* Memory with HoverCard for htop-style bar and top processes */}
                <HoverCard openDelay={200} closeDelay={100}>
                  <HoverCardTrigger asChild>
                    <button
                      className="flex items-center gap-0.5 hover:opacity-100 opacity-80 transition-opacity cursor-pointer min-w-0 shrink"
                      aria-label={t("terminal.serverStats.memory")}
                    >
                      <MemoryStick size={10} className="flex-shrink-0" />
                      <span className="truncate">
                        {serverStats.memUsed !== null && serverStats.memTotal !== null
                          ? `${(serverStats.memUsed / 1024).toFixed(1)}/${(serverStats.memTotal / 1024).toFixed(1)}G`
                          : '--'}
                      </span>
                    </button>
                  </HoverCardTrigger>
                  <HoverCardContent
                    className="w-auto p-3"
                    side="bottom"
                    align="start"
                    sideOffset={8}
                  >
                    <div className="text-xs space-y-3 min-w-[280px]">
                      <div className="font-medium text-sm">{t("terminal.serverStats.memoryDetails")}</div>
                      {/* htop-style memory bar */}
                      {serverStats.memTotal !== null && (
                        <div className="space-y-1.5">
                          <div className="w-full h-3 bg-muted rounded overflow-hidden flex">
                            {/* Used (green) — exact value shown in legend below */}
                            {serverStats.memUsed !== null && serverStats.memUsed > 0 && (
                              <div
                                className="h-full bg-emerald-500"
                                style={{ width: `${(serverStats.memUsed / serverStats.memTotal) * 100}%` }}
                              />
                            )}
                            {/* Buffers (blue) */}
                            {serverStats.memBuffers !== null && serverStats.memBuffers > 0 && (
                              <div
                                className="h-full bg-blue-500"
                                style={{ width: `${(serverStats.memBuffers / serverStats.memTotal) * 100}%` }}
                              />
                            )}
                            {/* Cached (amber/orange) */}
                            {serverStats.memCached !== null && serverStats.memCached > 0 && (
                              <div
                                className="h-full bg-amber-500"
                                style={{ width: `${(serverStats.memCached / serverStats.memTotal) * 100}%` }}
                              />
                            )}
                          </div>
                          {/* Legend */}
                          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px]">
                            <div className="flex items-center gap-1">
                              <div className="w-2 h-2 rounded-sm bg-emerald-500" />
                              <span>{t("terminal.serverStats.memUsed")}: {serverStats.memUsed !== null ? `${(serverStats.memUsed / 1024).toFixed(1)}G` : '--'}</span>
                            </div>
                            <div className="flex items-center gap-1">
                              <div className="w-2 h-2 rounded-sm bg-blue-500" />
                              <span>{t("terminal.serverStats.memBuffers")}: {serverStats.memBuffers !== null ? `${(serverStats.memBuffers / 1024).toFixed(1)}G` : '--'}</span>
                            </div>
                            <div className="flex items-center gap-1">
                              <div className="w-2 h-2 rounded-sm bg-amber-500" />
                              <span>{t("terminal.serverStats.memCached")}: {serverStats.memCached !== null ? `${(serverStats.memCached / 1024).toFixed(1)}G` : '--'}</span>
                            </div>
                            <div className="flex items-center gap-1">
                              <div className="w-2 h-2 rounded-sm bg-muted border border-border" />
                              <span>{t("terminal.serverStats.memFree")}: {serverStats.memFree !== null ? `${(serverStats.memFree / 1024).toFixed(1)}G` : '--'}</span>
                            </div>
                          </div>
                        </div>
                      )}
                      {/* Swap bar */}
                      {serverStats.swapTotal !== null && serverStats.swapTotal > 0 && (
                        <div className="space-y-1.5">
                          <div className="font-medium text-[11px] text-muted-foreground">{t("terminal.serverStats.swap")}</div>
                          <div className="w-full h-3 bg-muted rounded overflow-hidden flex">
                            {serverStats.swapUsed !== null && serverStats.swapUsed > 0 && (
                              <div
                                className="h-full bg-rose-500"
                                style={{ width: `${(serverStats.swapUsed / serverStats.swapTotal) * 100}%` }}
                              />
                            )}
                          </div>
                          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px]">
                            <div className="flex items-center gap-1">
                              <div className="w-2 h-2 rounded-sm bg-rose-500" />
                              <span>{t("terminal.serverStats.swapUsed")}: {serverStats.swapUsed !== null ? `${(serverStats.swapUsed / 1024).toFixed(1)}G` : '--'}</span>
                            </div>
                            <div className="flex items-center gap-1">
                              <div className="w-2 h-2 rounded-sm bg-muted border border-border" />
                              <span>{t("terminal.serverStats.swapFree")}: {serverStats.swapTotal !== null && serverStats.swapUsed !== null ? `${((serverStats.swapTotal - serverStats.swapUsed) / 1024).toFixed(1)}G` : '--'}</span>
                            </div>
                            <div className="flex items-center gap-1">
                              <span className="text-muted-foreground">{t("terminal.serverStats.swapTotal")}: {`${(serverStats.swapTotal / 1024).toFixed(1)}G`}</span>
                            </div>
                          </div>
                        </div>
                      )}
                      {/* Top 10 processes */}
                      {serverStats.topProcesses.length > 0 && (
                        <div className="space-y-1.5">
                          <div className="font-medium text-[11px] text-muted-foreground">{t("terminal.serverStats.topProcesses")}</div>
                          <div className="space-y-0.5 max-h-[150px] overflow-y-auto">
                            {serverStats.topProcesses.map((proc, index) => (
                              <div key={index} className="flex items-center gap-2 text-[10px]">
                                <span className="w-[32px] text-right text-muted-foreground">{proc.memPercent.toFixed(1)}%</span>
                                <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden">
                                  <div
                                    className="h-full bg-emerald-500 rounded-full"
                                    style={{ width: `${Math.min(100, proc.memPercent * 2)}%` }}
                                  />
                                </div>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span className="flex-shrink-0 font-mono truncate max-w-[140px] cursor-default">
                                      {proc.command.split('/').pop()?.split(' ')[0] || proc.command}
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent>{proc.command}</TooltipContent>
                                </Tooltip>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </HoverCardContent>
                </HoverCard>
                {/* Disk - with HoverCard for disk details */}
                <HoverCard openDelay={200} closeDelay={100}>
                  <HoverCardTrigger asChild>
                    <button
                      className="flex items-center gap-0.5 hover:opacity-100 opacity-80 transition-opacity cursor-pointer min-w-0 shrink"
                      aria-label={t("terminal.serverStats.disk")}
                    >
                      <HardDrive size={10} className="flex-shrink-0" />
                      <span className={cn(
                        "truncate",
                        serverStats.diskPercent !== null && serverStats.diskPercent >= 90 && "text-red-400",
                        serverStats.diskPercent !== null && serverStats.diskPercent >= 80 && serverStats.diskPercent < 90 && "text-amber-400"
                      )}>
                        {serverStats.diskUsed !== null && serverStats.diskTotal !== null && serverStats.diskPercent !== null
                          ? `${serverStats.diskUsed}/${serverStats.diskTotal}G (${serverStats.diskPercent}%)`
                          : serverStats.diskPercent !== null
                            ? `${serverStats.diskPercent}%`
                            : '--'}
                      </span>
                    </button>
                  </HoverCardTrigger>
                  <HoverCardContent
                    className="w-auto p-3"
                    side="bottom"
                    align="start"
                    sideOffset={8}
                  >
                    <div className="text-xs space-y-2">
                      <div className="font-medium text-sm mb-2">{t("terminal.serverStats.diskDetails")}</div>
                      {serverStats.disks.length > 0 ? (
                        <div className="space-y-2 max-h-[200px] overflow-y-auto">
                          {serverStats.disks.map((disk, index) => (
                            <div key={index} className="flex flex-col gap-1 min-w-[180px]">
                              <div className="flex items-center justify-between gap-4">
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span className="text-[10px] text-muted-foreground font-mono truncate max-w-[120px] cursor-default">
                                      {disk.mountPoint}
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent>{disk.mountPoint}</TooltipContent>
                                </Tooltip>
                                <span className={cn(
                                  "text-[11px] font-medium whitespace-nowrap",
                                  disk.percent >= 90 ? "text-red-400" : disk.percent >= 80 ? "text-amber-400" : "text-emerald-400"
                                )}>
                                  {disk.used}/{disk.total}G ({disk.percent}%)
                                </span>
                              </div>
                              <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
                                <div
                                  className={cn(
                                    "h-full rounded-full transition-all",
                                    disk.percent >= 90 ? "bg-red-500" : disk.percent >= 80 ? "bg-amber-500" : "bg-emerald-500"
                                  )}
                                  style={{ width: `${disk.percent}%` }}
                                />
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="text-muted-foreground">{t("terminal.serverStats.noData")}</div>
                      )}
                    </div>
                  </HoverCardContent>
                </HoverCard>
                {/* Network - with HoverCard for per-interface details */}
                {serverStats.netInterfaces.length > 0 && (
                  <HoverCard openDelay={200} closeDelay={100}>
                    <HoverCardTrigger asChild>
                      <button
                        className="flex items-center gap-1 hover:opacity-100 opacity-80 transition-opacity cursor-pointer min-w-0 shrink"
                        aria-label={t("terminal.serverStats.network")}
                      >
                        <ArrowDownToLine size={9} className="flex-shrink-0 text-emerald-400" />
                        <span className="truncate">{formatNetSpeed(serverStats.netRxSpeed)}</span>
                        <ArrowUpFromLine size={9} className="flex-shrink-0 text-sky-400" />
                        <span className="truncate">{formatNetSpeed(serverStats.netTxSpeed)}</span>
                      </button>
                    </HoverCardTrigger>
                    <HoverCardContent
                      className="w-auto p-3"
                      side="bottom"
                      align="start"
                      sideOffset={8}
                    >
                      <div className="text-xs space-y-2">
                        <div className="font-medium text-sm mb-2">{t("terminal.serverStats.networkDetails")}</div>
                        <div className="space-y-2 max-h-[200px] overflow-y-auto">
                          {serverStats.netInterfaces.map((iface, index) => (
                            <div key={index} className="flex items-center justify-between gap-4 min-w-[200px]">
                              <span className="text-[10px] text-muted-foreground font-mono">
                                {iface.name}
                              </span>
                              <div className="flex items-center gap-2">
                                <span className="flex items-center gap-0.5 text-emerald-400">
                                  <ArrowDownToLine size={9} />
                                  {formatNetSpeed(iface.rxSpeed)}
                                </span>
                                <span className="flex items-center gap-0.5 text-sky-400">
                                  <ArrowUpFromLine size={9} />
                                  {formatNetSpeed(iface.txSpeed)}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </HoverCardContent>
                  </HoverCard>
                )}
              </div>
  );
};
