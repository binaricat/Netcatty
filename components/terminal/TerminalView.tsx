/* eslint-disable @typescript-eslint/no-explicit-any */
import React from 'react';

type TerminalViewContext = Record<string, any>;

export function TerminalView({ ctx }: { ctx: TerminalViewContext }) {
  const { ArrowDownToLine, ArrowUpFromLine, Button, Copy, Cpu, HardDrive, HoverCard, HoverCardContent, HoverCardTrigger, Maximize2, MemoryStick, Radio, TerminalAutocomplete, TerminalComposeBar, TerminalConnectionDialog, TerminalContextMenu, TerminalSearchBar, Tooltip, TooltipContent, TooltipTrigger, ZmodemOverwriteDialog, ZmodemProgressIndicator, auth, autocompleteAcceptTextRef, autocompleteCloseRef, autocompleteHostOs, autocompleteInputRef, autocompleteKeyEventRef, autocompleteRepositionRef, autocompleteSettings, chainProgress, cn, containerRef, effectiveTheme, error, executeSnippetCommand, formatNetSpeed, handleCancelConnect, handleCloseDisconnectedSession, handleCloseSearch, handleDismissDisconnectedDialog, handleDragEnter, handleDragLeave, handleDragOver, handleDrop, handleFindNext, handleFindPrevious, handleHostKeyAddAndContinue, handleHostKeyClose, handleHostKeyContinue, handleOsc52ReadResponse, handleRetry, handleSearch, handleTopOverlayMouseDownCapture, hasMouseTracking, hasSelection, host, hotkeyScheme, inWorkspace, isBroadcastEnabled, isCancelling, isComposeBarOpen, isDraggingOver, isFocusMode, isLocalConnection, isSearchOpen, isVisible, keyBindings, keys, knownCwdRef, needsHostKeyVerification, onBroadcastInput, onCloseSession, onExpandToFocus, onSplitHorizontal, onSplitVertical, onToggleBroadcast, osc52ReadPromptVisible, pendingHostKeyInfo, progressLogs, progressValue, renderControls, scrollToBottomAfterProgrammaticInput, searchMatchCount, serverStats, sessionId, sessionRef, setIsComposeBarOpen, setShowLogs, shouldShowConnectionDialog, showLogs, snippets, status, statusDotTone, t, termRef, terminalBackend, terminalContextActions, terminalCwdTracker, terminalPreviewVars, terminalSettings, timeLeft, toast, zmodem } = ctx;
  return (
    <TerminalContextMenu
      hasSelection={hasSelection}
      hotkeyScheme={hotkeyScheme}
      keyBindings={keyBindings}
      rightClickBehavior={terminalSettings?.rightClickBehavior}
      isAlternateScreen={hasMouseTracking}
      onCopy={terminalContextActions.onCopy}
      onPaste={terminalContextActions.onPaste}
      onPasteSelection={terminalContextActions.onPasteSelection}
      onSelectAll={terminalContextActions.onSelectAll}
      onClear={terminalContextActions.onClear}
      onSelectWord={terminalContextActions.onSelectWord}
      onSplitHorizontal={onSplitHorizontal}
      onSplitVertical={onSplitVertical}
      isReconnectable={status === "disconnected"}
      onReconnect={handleRetry}
      onClose={inWorkspace ? () => onCloseSession?.(sessionId) : undefined}
    >
      <div
        className={cn(
          "relative h-full w-full flex overflow-hidden bg-gradient-to-br from-[#050910] via-[#06101a] to-[#0b1220]",
          isComposeBarOpen && !inWorkspace && "flex-col"
        )}
        style={terminalPreviewVars}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Drag and drop overlay */}
        {isDraggingOver && (
          <div className="absolute inset-0 z-50 bg-blue-600/20 backdrop-blur-sm border-4 border-dashed border-blue-400 pointer-events-none flex items-center justify-center">
            <div className="bg-background/90 backdrop-blur-md rounded-lg shadow-lg p-6 border border-border">
              <div className="text-center">
                <div className="text-lg font-semibold mb-2">
                  {isLocalConnection
                    ? t("terminal.dragDrop.localTitle")
                    : t("terminal.dragDrop.remoteTitle")
                  }
                </div>
                <div className="text-sm text-muted-foreground">
                  {isLocalConnection
                    ? t("terminal.dragDrop.localMessage")
                    : t("terminal.dragDrop.remoteMessage")
                  }
                </div>
              </div>
            </div>
          </div>
        )}
        <div className="absolute left-0 right-0 top-0 z-20 pointer-events-none">
          <div
            className="flex items-center gap-1 px-2 py-0.5 backdrop-blur-md pointer-events-auto min-w-0"
            onMouseDownCapture={handleTopOverlayMouseDownCapture}
            style={{
              backgroundColor: 'var(--terminal-ui-bg)',
              color: 'var(--terminal-ui-fg)',
              borderColor: 'var(--terminal-ui-border)',
              ['--terminal-toolbar-fg' as never]: 'var(--terminal-ui-fg)',
              ['--terminal-toolbar-bg' as never]: 'var(--terminal-ui-bg)',
              ['--terminal-toolbar-btn' as never]: 'var(--terminal-ui-toolbar-btn)',
              ['--terminal-toolbar-btn-hover' as never]: 'var(--terminal-ui-toolbar-btn-hover)',
              ['--terminal-toolbar-btn-active' as never]: 'var(--terminal-ui-toolbar-btn-active)',
            }}
          >
            <div className="flex items-center gap-1 text-[11px] font-semibold">
              <span className="whitespace-nowrap">{host.label}</span>
              <span
                className={cn(
                  "inline-block h-2 w-2 rounded-full flex-shrink-0",
                  statusDotTone,
                )}
              />
              {host.protocol !== "local" && host.hostname && host.hostname !== "localhost" && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="ml-0.5 p-0.5 rounded hover:bg-[color:var(--terminal-toolbar-btn-hover)] transition-colors opacity-60 hover:opacity-100 flex-shrink-0"
                      onClick={() => {
                        void navigator.clipboard.writeText(host.hostname).then(() => {
                          toast.success(t("terminal.statusbar.copyHostname.toast", { hostname: host.hostname }));
                        }).catch(() => {
                          toast.error(t("terminal.statusbar.copyHostname.error"));
                        });
                      }}
                      aria-label={t("terminal.statusbar.copyHostname.label")}
                    >
                      <Copy size={10} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{t("terminal.statusbar.copyHostname.tooltip", { hostname: host.hostname })}</TooltipContent>
                </Tooltip>
              )}
            </div>
            {/* Server Stats Display */}
            {terminalSettings?.showServerStats && status === 'connected' && serverStats.lastUpdated && (
              <div className="flex items-center gap-2.5 ml-2 text-[10px] opacity-80 flex-nowrap overflow-hidden min-w-0">
                {/* CPU with HoverCard for per-core details */}
                <HoverCard openDelay={200} closeDelay={100}>
                  <HoverCardTrigger asChild>
                    <button
                      className="flex items-center gap-0.5 hover:opacity-100 opacity-80 transition-opacity cursor-pointer flex-shrink-0"
                      aria-label={t("terminal.serverStats.cpu")}
                    >
                      <Cpu size={10} className="flex-shrink-0" />
                      <span>
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
                      className="flex items-center gap-0.5 hover:opacity-100 opacity-80 transition-opacity cursor-pointer flex-shrink-0"
                      aria-label={t("terminal.serverStats.memory")}
                    >
                      <MemoryStick size={10} className="flex-shrink-0" />
                      <span>
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
                      className="flex items-center gap-0.5 hover:opacity-100 opacity-80 transition-opacity cursor-pointer flex-shrink-0"
                      aria-label={t("terminal.serverStats.disk")}
                    >
                      <HardDrive size={10} className="flex-shrink-0" />
                      <span className={cn(
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
                        className="flex items-center gap-1 hover:opacity-100 opacity-80 transition-opacity cursor-pointer flex-shrink-0"
                        aria-label={t("terminal.serverStats.network")}
                      >
                        <ArrowDownToLine size={9} className="flex-shrink-0 text-emerald-400" />
                        <span>{formatNetSpeed(serverStats.netRxSpeed)}</span>
                        <ArrowUpFromLine size={9} className="flex-shrink-0 text-sky-400" />
                        <span>{formatNetSpeed(serverStats.netTxSpeed)}</span>
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
            )}
            <div className="flex-1" />
            <div className="flex items-center gap-0.5 flex-shrink-0">
              {inWorkspace && onToggleBroadcast && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="secondary"
                      size="icon"
                      className={cn(
                        "h-6 w-6 p-0 shadow-none border-none text-[color:var(--terminal-toolbar-fg)]",
                        "bg-transparent hover:bg-transparent",
                        isBroadcastEnabled && "text-green-500",
                      )}
                      onClick={onToggleBroadcast}
                      aria-label={
                        isBroadcastEnabled
                          ? t("terminal.toolbar.broadcastDisable")
                          : t("terminal.toolbar.broadcastEnable")
                      }
                    >
                      <Radio size={12} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {isBroadcastEnabled
                      ? t("terminal.toolbar.broadcastDisable")
                      : t("terminal.toolbar.broadcastEnable")}
                  </TooltipContent>
                </Tooltip>
              )}
              {inWorkspace && !isFocusMode && onExpandToFocus && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="secondary"
                      size="icon"
                      className="h-6 w-6 p-0 shadow-none border-none text-[color:var(--terminal-toolbar-fg)] bg-transparent hover:bg-transparent"
                      onClick={onExpandToFocus}
                      aria-label={t("terminal.toolbar.focusMode")}
                    >
                      <Maximize2 size={12} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{t("terminal.toolbar.focusMode")}</TooltipContent>
                </Tooltip>
              )}
              {renderControls({ showClose: inWorkspace })}
            </div>
          </div>
          {isSearchOpen && (
            <div className="pointer-events-auto">
              <TerminalSearchBar
                isOpen={isSearchOpen}
                onClose={handleCloseSearch}
                onSearch={handleSearch}
                onFindNext={handleFindNext}
                onFindPrevious={handleFindPrevious}
                matchCount={searchMatchCount}
              />
            </div>
          )}
        </div>

        <div
          className="h-full flex-1 min-w-0 relative overflow-hidden pt-8"
          style={{ backgroundColor: 'var(--terminal-ui-bg)' }}
        >
          <div
            ref={containerRef}
            className="xterm-container absolute inset-x-0 bottom-0"
            style={{
              top: isSearchOpen ? "64px" : "30px",
              paddingLeft: 6,
              backgroundColor: 'var(--terminal-ui-bg)',
            }}
          />

          {/* Autocomplete — owns the hook + popup in its own component so
              suggestion/selection updates don't re-render Terminal. Mounted
              unconditionally; it gates the popup on `visible` internally. */}
          <TerminalAutocomplete
            termRef={termRef}
            sessionId={sessionId}
            hostId={host.id}
            hostOs={autocompleteHostOs}
            settings={autocompleteSettings}
            protocol={host.protocol}
            getCwd={() => terminalCwdTracker.getRendererCwd() ?? knownCwdRef.current}
            onAcceptText={(text) => autocompleteAcceptTextRef.current?.(text)}
            snippets={snippets}
            onAcceptSnippet={(snippet) => executeSnippetCommand(snippet.command, snippet.noAutoRun)}
            visible={isVisible}
            themeColors={effectiveTheme.colors}
            containerRef={containerRef}
            searchBarOffset={isSearchOpen ? 64 : 30}
            keyEventRef={autocompleteKeyEventRef}
            inputRef={autocompleteInputRef}
            repositionRef={autocompleteRepositionRef}
            closeRef={autocompleteCloseRef}
          />

          {/* OSC-52 clipboard read prompt */}
          {osc52ReadPromptVisible && (
            <div
              className="absolute inset-0 z-40 flex items-center justify-center bg-background/60"
              onKeyDown={(e) => {
                if (e.key === 'Escape') handleOsc52ReadResponse(false);
              }}
            >
              <div className="rounded-lg border bg-card p-4 shadow-lg max-w-sm space-y-3">
                <p className="text-sm font-medium">{t("terminal.osc52.readPrompt.title")}</p>
                <p className="text-sm text-muted-foreground">{t("terminal.osc52.readPrompt.desc")}</p>
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" size="sm" onClick={() => handleOsc52ReadResponse(false)}>
                    {t("terminal.osc52.readPrompt.deny")}
                  </Button>
                  <Button size="sm" autoFocus onClick={() => handleOsc52ReadResponse(true)}>
                    {t("terminal.osc52.readPrompt.allow")}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Connection dialog: skip for local/serial during connecting phase, but show on error */}
          {shouldShowConnectionDialog && (
              <TerminalConnectionDialog
                host={host}
                status={status}
                error={error}
                progressValue={progressValue}
                chainProgress={chainProgress}
                needsAuth={auth.needsAuth}
                showLogs={showLogs}
                _setShowLogs={setShowLogs}
                keys={keys}
                onDismissDisconnected={handleDismissDisconnectedDialog}
                hostKeyVerification={needsHostKeyVerification && pendingHostKeyInfo ? {
                  hostKeyInfo: pendingHostKeyInfo,
                  onClose: handleHostKeyClose,
                  onContinue: handleHostKeyContinue,
                  onAddAndContinue: handleHostKeyAddAndContinue,
                } : undefined}
                authProps={{
                  authMethod: auth.authMethod,
                  setAuthMethod: auth.setAuthMethod,
                  authUsername: auth.authUsername,
                  setAuthUsername: auth.setAuthUsername,
                  authPassword: auth.authPassword,
                  setAuthPassword: auth.setAuthPassword,
                  authKeyId: auth.authKeyId,
                  setAuthKeyId: auth.setAuthKeyId,
                  authPassphrase: auth.authPassphrase,
                  setAuthPassphrase: auth.setAuthPassphrase,
                  showAuthPassphrase: auth.showAuthPassphrase,
                  setShowAuthPassphrase: auth.setShowAuthPassphrase,
                  showAuthPassword: auth.showAuthPassword,
                  setShowAuthPassword: auth.setShowAuthPassword,
                  authRetryMessage: auth.authRetryMessage,
                  onSubmit: () => auth.submit(),
                  onSubmitWithoutSave: () => auth.submit({ saveToHost: false }),
                  onCancel: handleCancelConnect,
                  isValid: auth.isValid,
                }}
                progressProps={{
                  timeLeft,
                  isCancelling,
                  progressLogs,
                  onCancelConnect: handleCancelConnect,
                  onCloseSession: handleCloseDisconnectedSession,
                  onRetry: handleRetry,
                }}
              />
            )}

          {/* ZMODEM transfer progress indicator */}
          {zmodem.active && (
            <div className="absolute bottom-4 right-4 z-[25] pointer-events-auto">
              <ZmodemProgressIndicator
                transferType={zmodem.transferType}
                filename={zmodem.filename}
                transferred={zmodem.transferred}
                total={zmodem.total}
                fileIndex={zmodem.fileIndex}
                fileCount={zmodem.fileCount}
                finalizing={zmodem.finalizing}
                onCancel={zmodem.cancel}
              />
            </div>
          )}
          {/* ZMODEM overwrite conflict dialog */}
          {zmodem.overwriteRequest && (
            <ZmodemOverwriteDialog
              filename={zmodem.overwriteRequest.filename}
              onRespond={zmodem.respondOverwrite}
            />
          )}
        </div>

        {/* Compose Bar (solo sessions only; workspace uses TerminalLayer's global bar) */}
        {isComposeBarOpen && !inWorkspace && (
          <TerminalComposeBar
            onSend={(text) => {
              if (sessionRef.current) {
                const payload = text + '\r';
                terminalBackend.writeToSession(sessionRef.current, payload);
                scrollToBottomAfterProgrammaticInput(payload);
                onBroadcastInput?.(payload, sessionRef.current);
              }
            }}
            onClose={() => {
              setIsComposeBarOpen(false);
              termRef.current?.focus();
            }}
            isBroadcastEnabled={isBroadcastEnabled}
            themeColors={effectiveTheme.colors}
          />
        )}
      </div>
    </TerminalContextMenu>
  );
}
