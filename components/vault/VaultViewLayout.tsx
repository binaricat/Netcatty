/* eslint-disable @typescript-eslint/no-explicit-any */
import React from "react";
import { VaultHostListSection } from "./VaultHostListSection";

type VaultViewLayoutContext = Record<string, any>;

export function VaultViewLayout({ ctx }: { ctx: VaultViewLayoutContext }) {
  const { Activity, allGroupPaths, allTags, AppLogo, Array, Badge, BookMarked, Boolean, Button, CheckSquare, ChevronDown, clearHostSelection, ClipboardCopy, Clock, cn, connectionLogs, connectSelectedHosts, ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger, Copy, currentSection, customGroups, deleteGroupPath, deleteGroupWithHosts, deleteSelectedHosts, deleteTargetPath, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, displayedGroups, displayedHosts, DistroAvatar, Download, Dropdown, DropdownContent, DropdownTrigger, Edit2, editingGroupPath, editingHost, editingHostGroupDefaults, FileCode, FileSymlink, FolderPlus, FolderTree, getDropTargetClasses, getEffectiveHostDistro, Globe, groupConfigs, GroupDetailsPanel, groupedDisplayHosts, handleConnectClick, handleCopyCredentials, handleDeleteTag, handleDuplicateHost, handleEditGroupConfig, handleEditHost, handleEditTag, handleExportHosts, handleHostConnect, handleImportFileSelected, handleNewHost, handleProtocolSelect, handleQuickConnect, handleQuickConnectSaveHost, handleSaveGroupConfig, handleSearchKeyDown, handleUnmanageGroup, hasHostsSidePanel, HostDetailsPanel, hostListScrollRef, hosts, HostTreeView, hotkeyScheme, identities, ImportVaultDialog, Input, isDeleteGroupOpen, isGroupPanelOpen, isHostPanelOpen, isHostsSectionActive, isImportOpen, isMultiSelectMode, isNewFolderOpen, isQuickConnectOpen, isRenameGroupOpen, isSearchQuickConnect, isSerialModalOpen, Key, keyBindings, KeychainManager, keys, knownHostsManagerElement, Label, lastPinnedId, LayoutGrid, LazyConnectionLogsManager, LazyProtocolSelectDialog, List, managedGroupPaths, managedSources, moveGroup, moveHostToGroup, Network, newFolderName, newHostGroupPath, onClearUnsavedConnectionLogs, onConnectSerial, onCreateLocalTerminal, onDeleteConnectionLog, onDeleteHost, onImportOrReuseKey, onOpenLogView, onOpenSettings, onRunSnippet, onToggleConnectionLogSaved, onUpdateCustomGroups, onUpdateGroupConfigs, onUpdateHosts, onUpdateIdentities, onUpdateKeys, onUpdateProxyProfiles, onUpdateSnippetPackages, onUpdateSnippets, Pin, pinnedHosts, pinnedRecentIds, Plug, Plus, PortForwarding, protocolSelectHost, proxyProfiles, ProxyProfilesManager, quickConnectTarget, quickConnectWarnings, QuickConnectWizard, recentHosts, renameGroupError, renameGroupName, renameTargetPath, RippleButton, rootRef, sanitizeHost, search, Search, selectedGroupPath, selectedHostIds, selectedTags, SerialConnectModal, SerialHostDetailsPanel, sessionCount, Set, setCurrentSection, setDeleteGroupWithHosts, setDeleteTargetPath, setDragOverDropTarget, setEditingGroupPath, setEditingHost, setGroupDragOverDropTarget, setIsDeleteGroupOpen, setIsGroupPanelOpen, setIsHostPanelOpen, setIsImportOpen, setIsMultiSelectMode, setIsNewFolderOpen, setIsQuickConnectOpen, setIsRenameGroupOpen, setIsSerialModalOpen, setLastPinnedId, setNewFolderName, setNewHostGroupPath, setProtocolSelectHost, setQuickConnectTarget, setQuickConnectWarnings, setRenameGroupError, setRenameGroupName, setRenameTargetPath, setSearch, setSelectedGroupPath, setSelectedHostIds, setSelectedTags, setSidebarCollapsed, setSortMode, setTargetParentPath, Settings, setViewMode, shellHistory, shouldHideEmptyRootHostsSection, showRecentHosts, sidebarCollapsed, snippetPackages, snippets, SnippetsManager, SortDropdown, sortMode, splitViewGridStyle, Square, Star, submitNewFolder, submitRenameGroup, Suspense, t, TagFilterDropdown, targetParentPath, terminalFontSize, terminalSettings, TerminalSquare, terminalThemeId, toggleHostPinned, toggleHostSelection, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, Trash2, treeExpandedState, treeViewGroupTree, treeViewHosts, Upload, upsertHostById, Usb, viewMode, visibleDisplayedHosts, X, Zap } = ctx;
  return (
    <div ref={rootRef} className="absolute inset-0 min-h-0 flex" data-section="vault-view">
      {/* Sidebar */}
      <TooltipProvider delayDuration={100}>
        <div
          className={cn(
            "bg-secondary border-r border-border/60 flex flex-col transition-all duration-200",
            sidebarCollapsed ? "w-14" : "w-52"
          )}
          data-section="vault-sidebar"
        >
          <div className={cn(
            "pt-5 pb-6 flex items-center",
            sidebarCollapsed ? "px-2 justify-center" : "px-4"
          )}>
            <Tooltip delayDuration={500}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                  className="flex items-center gap-2.5 hover:opacity-80 transition-opacity"
                >
                  <AppLogo className="h-8 w-8 flex-shrink-0" />
                  {!sidebarCollapsed && (
                    <p className="text-xl font-black italic tracking-tight text-foreground leading-none">
                      Netcatty
                    </p>
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">
                {sidebarCollapsed ? t("vault.sidebar.expand") : t("vault.sidebar.collapse")}
              </TooltipContent>
            </Tooltip>
          </div>

          <div className={cn("space-y-1", sidebarCollapsed ? "px-1.5" : "px-3")}>
            <Tooltip>
              <TooltipTrigger asChild>
                <RippleButton
                  variant={currentSection === "hosts" ? "secondary" : "ghost"}
                  className={cn(
                    "w-full h-10",
                    sidebarCollapsed ? "justify-center p-0" : "justify-start gap-3",
                    currentSection === "hosts" &&
                    "bg-foreground/10 text-foreground hover:bg-foreground/15 border-border/40",
                  )}
                  onClick={() => {
                    setCurrentSection("hosts");
                    setSelectedGroupPath(null);
                  }}
                >
                  <LayoutGrid size={16} className="flex-shrink-0" />
                  {!sidebarCollapsed && t("vault.nav.hosts")}
                </RippleButton>
              </TooltipTrigger>
              {sidebarCollapsed && <TooltipContent side="right">{t("vault.nav.hosts")}</TooltipContent>}
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <RippleButton
                  variant={currentSection === "keys" ? "secondary" : "ghost"}
                  className={cn(
                    "w-full h-10",
                    sidebarCollapsed ? "justify-center p-0" : "justify-start gap-3",
                    currentSection === "keys" &&
                    "bg-foreground/10 text-foreground hover:bg-foreground/15 border-border/40",
                  )}
                  onClick={() => {
                    setCurrentSection("keys");
                  }}
                >
                  <Key size={16} className="flex-shrink-0" />
                  {!sidebarCollapsed && t("vault.nav.keychain")}
                </RippleButton>
              </TooltipTrigger>
              {sidebarCollapsed && <TooltipContent side="right">{t("vault.nav.keychain")}</TooltipContent>}
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <RippleButton
                  variant={currentSection === "proxies" ? "secondary" : "ghost"}
                  className={cn(
                    "w-full h-10",
                    sidebarCollapsed ? "justify-center p-0" : "justify-start gap-3",
                    currentSection === "proxies" &&
                    "bg-foreground/10 text-foreground hover:bg-foreground/15 border-border/40",
                  )}
                  onClick={() => {
                    setCurrentSection("proxies");
                  }}
                >
                  <Globe size={16} className="flex-shrink-0" />
                  {!sidebarCollapsed && t("vault.nav.proxies")}
                </RippleButton>
              </TooltipTrigger>
              {sidebarCollapsed && <TooltipContent side="right">{t("vault.nav.proxies")}</TooltipContent>}
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <RippleButton
                  variant={currentSection === "port" ? "secondary" : "ghost"}
                  className={cn(
                    "w-full h-10",
                    sidebarCollapsed ? "justify-center p-0" : "justify-start gap-3",
                    currentSection === "port" &&
                    "bg-foreground/10 text-foreground hover:bg-foreground/15 border-border/40",
                  )}
                  onClick={() => setCurrentSection("port")}
                >
                  <Plug size={16} className="flex-shrink-0" />
                  {!sidebarCollapsed && t("vault.nav.portForwarding")}
                </RippleButton>
              </TooltipTrigger>
              {sidebarCollapsed && <TooltipContent side="right">{t("vault.nav.portForwarding")}</TooltipContent>}
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <RippleButton
                  variant={currentSection === "snippets" ? "secondary" : "ghost"}
                  className={cn(
                    "w-full h-10",
                    sidebarCollapsed ? "justify-center p-0" : "justify-start gap-3",
                    currentSection === "snippets" &&
                    "bg-foreground/10 text-foreground hover:bg-foreground/15 border-border/40",
                  )}
                  onClick={() => {
                    setCurrentSection("snippets");
                  }}
                >
                  <FileCode size={16} className="flex-shrink-0" />
                  {!sidebarCollapsed && t("vault.nav.snippets")}
                </RippleButton>
              </TooltipTrigger>
              {sidebarCollapsed && <TooltipContent side="right">{t("vault.nav.snippets")}</TooltipContent>}
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <RippleButton
                  variant={currentSection === "knownhosts" ? "secondary" : "ghost"}
                  className={cn(
                    "w-full h-10",
                    sidebarCollapsed ? "justify-center p-0" : "justify-start gap-3",
                    currentSection === "knownhosts" &&
                    "bg-foreground/10 text-foreground hover:bg-foreground/15 border-border/40",
                  )}
                  onClick={() => setCurrentSection("knownhosts")}
                >
                  <BookMarked size={16} className="flex-shrink-0" />
                  {!sidebarCollapsed && t("vault.nav.knownHosts")}
                </RippleButton>
              </TooltipTrigger>
              {sidebarCollapsed && <TooltipContent side="right">{t("vault.nav.knownHosts")}</TooltipContent>}
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <RippleButton
                  variant={currentSection === "logs" ? "secondary" : "ghost"}
                  className={cn(
                    "w-full h-10",
                    sidebarCollapsed ? "justify-center p-0" : "justify-start gap-3",
                    currentSection === "logs" &&
                    "bg-foreground/10 text-foreground hover:bg-foreground/15 border-border/40",
                  )}
                  onClick={() => setCurrentSection("logs")}
                >
                  <Activity size={16} className="flex-shrink-0" />
                  {!sidebarCollapsed && t("vault.nav.logs")}
                </RippleButton>
              </TooltipTrigger>
              {sidebarCollapsed && <TooltipContent side="right">{t("vault.nav.logs")}</TooltipContent>}
            </Tooltip>
          </div>

          <div className={cn("mt-auto pb-4 space-y-2", sidebarCollapsed ? "px-1.5" : "px-3")}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  className={cn(
                    "w-full",
                    sidebarCollapsed ? "justify-center p-0" : "justify-start gap-3"
                  )}
                  onClick={onOpenSettings}
                >
                  <Settings size={16} className="flex-shrink-0" />
                  {!sidebarCollapsed && t("common.settings")}
                </Button>
              </TooltipTrigger>
              {sidebarCollapsed && <TooltipContent side="right">{t("common.settings")}</TooltipContent>}
            </Tooltip>
          </div>
        </div>
      </TooltipProvider>

      {/* Main Area */}
      <div
        className="flex-1 min-w-0 flex flex-col min-h-0 relative"
        data-section="vault-main"
      >
        <header
          className={cn(
            "border-b border-border/50 bg-secondary/80 backdrop-blur app-drag",
            !isHostsSectionActive && "hidden",
          )}
          data-section="vault-hosts-header"
        >
          <div className="h-14 px-4 py-2 flex items-center gap-3">
            <div className="relative flex-1 app-no-drag">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                placeholder={t("vault.hosts.search.placeholder")}
                className={cn(
                  "pl-9 h-10 bg-secondary border-border/60 text-sm",
                  isSearchQuickConnect &&
                  "border-primary/50 ring-1 ring-primary/20",
                )}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={handleSearchKeyDown}
              />
              {isSearchQuickConnect && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  <Zap size={14} className="text-primary" />
                </div>
              )}
            </div>
            <Button
              variant={isSearchQuickConnect ? "default" : "secondary"}
              className={cn(
                "h-10 px-4 app-no-drag",
                !isSearchQuickConnect &&
                "bg-foreground/5 text-foreground hover:bg-foreground/10 border-border/40",
              )}
              onClick={handleConnectClick}
            >
              {t("vault.hosts.connect")}
            </Button>
            {/* View mode, tag filter, and sort controls */}
            <div className="flex items-center gap-1 app-no-drag">
              <Dropdown>
                <DropdownTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-10 w-10 app-no-drag">
                    {viewMode === "grid" ? (
                      <LayoutGrid size={16} />
                    ) : viewMode === "list" ? (
                      <List size={16} />
                    ) : (
                      <Network size={16} />
                    )}
                    <ChevronDown size={10} className="ml-0.5" />
                  </Button>
                </DropdownTrigger>
                <DropdownContent className="w-32" align="end">
                  <Button
                    variant={viewMode === "grid" ? "secondary" : "ghost"}
                    className="w-full justify-start gap-2 h-9"
                    onClick={() => setViewMode("grid")}
                  >
                    <LayoutGrid size={14} /> {t("vault.view.grid")}
                  </Button>
                  <Button
                    variant={viewMode === "list" ? "secondary" : "ghost"}
                    className="w-full justify-start gap-2 h-9"
                    onClick={() => setViewMode("list")}
                  >
                    <List size={14} /> {t("vault.view.list")}
                  </Button>
                  <Button
                    variant={viewMode === "tree" ? "secondary" : "ghost"}
                    className="w-full justify-start gap-2 h-9"
                    onClick={() => setViewMode("tree")}
                  >
                    <Network size={14} /> {t("vault.view.tree")}
                  </Button>
                </DropdownContent>
              </Dropdown>
              <TagFilterDropdown
                allTags={allTags}
                selectedTags={selectedTags}
                onChange={setSelectedTags}
                onEditTag={handleEditTag}
                onDeleteTag={handleDeleteTag}
                className="h-10 w-10"
              />
              <SortDropdown
                value={sortMode}
                onChange={setSortMode}
                className="h-10 w-10"
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={isMultiSelectMode ? "secondary" : "ghost"}
                    size="icon"
                    className="h-10 w-10"
                    onClick={() => {
                      if (isMultiSelectMode) {
                        clearHostSelection();
                      } else {
                        setIsMultiSelectMode(true);
                      }
                    }}
                  >
                    <CheckSquare size={16} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("vault.hosts.multiSelect")}</TooltipContent>
              </Tooltip>
            </div>
            {/* New Host split button — collapses with an animation when the
                host details / new-host aside panel is open, since the button
                would be a no-op in that state. */}
            <div
              className={cn(
                "flex items-center app-no-drag overflow-hidden transition-[max-width,opacity,margin] duration-200 ease-in-out",
                isHostPanelOpen
                  ? "max-w-0 opacity-0 -ml-2 pointer-events-none"
                  : "max-w-[260px] opacity-100",
              )}
              aria-hidden={isHostPanelOpen}
            >
              <Dropdown>
                <div className="flex items-center rounded-md bg-primary text-primary-foreground">
                  <Button
                    size="sm"
                    className="h-10 px-3 rounded-r-none bg-transparent hover:bg-white/10 shadow-none app-no-drag"
                    onClick={handleNewHost}
                    tabIndex={isHostPanelOpen ? -1 : 0}
                  >
                    <Plus size={14} className="mr-2" /> {t("vault.hosts.newHost")}
                  </Button>
                  <DropdownTrigger asChild>
                    <Button
                      size="sm"
                      className="h-10 px-2 rounded-l-none bg-transparent hover:bg-white/10 border-l border-primary-foreground/20 shadow-none app-no-drag"
                      tabIndex={isHostPanelOpen ? -1 : 0}
                    >
                      <ChevronDown size={14} />
                    </Button>
                  </DropdownTrigger>
                </div>
                <DropdownContent className="w-44" align="end" alignToParent>
                  <Button
                    variant="ghost"
                    className="w-full justify-start gap-2"
                    onClick={() => {
                      setTargetParentPath(selectedGroupPath);
                      setNewFolderName("");
                      setIsNewFolderOpen(true);
                    }}
                  >
                    <FolderTree size={14} /> {t("vault.hosts.newGroup")}
                  </Button>
                  <Button
                    variant="ghost"
                    className="w-full justify-start gap-2"
                    onClick={() => {
                      setIsImportOpen(true);
                    }}
                  >
                    <Upload size={14} /> {t("vault.hosts.import")}
                  </Button>
                  <Button
                    variant="ghost"
                    className="w-full justify-start gap-2"
                    onClick={handleExportHosts}
                  >
                    <Download size={14} /> {t("vault.hosts.export")}
                  </Button>
                </DropdownContent>
              </Dropdown>
            </div>
            {/* Terminal + Serial — collapse together with an animation when
                the host details / new-host aside panel is open, freeing
                horizontal space for the panel. */}
            <div
              className={cn(
                "flex items-center gap-3 overflow-hidden transition-[max-width,opacity,margin] duration-200 ease-in-out",
                isHostPanelOpen
                  ? "max-w-0 opacity-0 -ml-3 pointer-events-none"
                  : "max-w-[320px] opacity-100",
              )}
              aria-hidden={isHostPanelOpen}
            >
              <Button
                size="sm"
                variant="secondary"
                className="h-10 px-3 app-no-drag bg-foreground/5 text-foreground hover:bg-foreground/10 border-border/40"
                onClick={onCreateLocalTerminal}
                tabIndex={isHostPanelOpen ? -1 : 0}
              >
                <TerminalSquare size={14} className="mr-2" /> {t("common.terminal")}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                className="h-10 px-3 app-no-drag bg-foreground/5 text-foreground hover:bg-foreground/10 border-border/40"
                onClick={() => setIsSerialModalOpen(true)}
                tabIndex={isHostPanelOpen ? -1 : 0}
              >
                <Usb size={14} className="mr-2" /> {t("serial.button")}
              </Button>
            </div>
          </div>
        </header>

        {isMultiSelectMode && isHostsSectionActive && (
          <div className="px-4 py-1.5 bg-background border-b border-border/40 flex items-center gap-2">
            <span className="flex items-center h-7 text-xs text-muted-foreground leading-none">
              {t("vault.hosts.selected", { count: selectedHostIds.size })}
            </span>
            <div className="flex-1" />
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => {
                const allIds = new Set(displayedHosts.map(h => h.id));
                setSelectedHostIds(allIds);
              }}
            >
              {t("vault.hosts.selectAll")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={clearHostSelection}
            >
              {t("vault.hosts.deselectAll")}
            </Button>
            <Button
              variant="default"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={selectedHostIds.size === 0}
              onClick={connectSelectedHosts}
            >
              <Plug size={12} className="mr-1" />
              {t("vault.hosts.connectSelected", { count: selectedHostIds.size })}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={selectedHostIds.size === 0}
              onClick={deleteSelectedHosts}
            >
              <Trash2 size={12} className="mr-1" />
              {t("vault.hosts.deleteSelected", { count: selectedHostIds.size })}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={clearHostSelection}
            >
              <X size={12} />
            </Button>
          </div>
        )}

        {/* Keep hosts mounted so switching sections does not reset scroll or remount the list. */}
        
        <VaultHostListSection ctx={{ Badge, Boolean, Button, CheckSquare, ClipboardCopy, Clock, cn, ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger, Copy, displayedGroups, displayedHosts, DistroAvatar, Edit2, FileSymlink, FolderPlus, FolderTree, getDropTargetClasses, getEffectiveHostDistro, groupConfigs, groupedDisplayHosts, handleCopyCredentials, handleDuplicateHost, handleEditGroupConfig, handleEditHost, handleHostConnect, handleUnmanageGroup, hasHostsSidePanel, hostListScrollRef, HostTreeView, isHostsSectionActive, isMultiSelectMode, lastPinnedId, LayoutGrid, managedGroupPaths, moveGroup, moveHostToGroup, onDeleteHost, Pin, pinnedHosts, pinnedRecentIds, Plug, recentHosts, sanitizeHost, selectedGroupPath, selectedHostIds, sessionCount, setDeleteTargetPath, setDragOverDropTarget, setEditingHost, setGroupDragOverDropTarget, setIsDeleteGroupOpen, setIsHostPanelOpen, setIsNewFolderOpen, setLastPinnedId, setNewFolderName, setNewHostGroupPath, setSelectedGroupPath, setTargetParentPath, shouldHideEmptyRootHostsSection, showRecentHosts, sortMode, splitViewGridStyle, Square, Star, t, toggleHostPinned, toggleHostSelection, Trash2, treeExpandedState, treeViewGroupTree, treeViewHosts, viewMode, visibleDisplayedHosts }} />

        {currentSection === "snippets" && (
          <SnippetsManager
            snippets={snippets}
            packages={snippetPackages}
            hosts={hosts}
            customGroups={customGroups}
            shellHistory={shellHistory}
            hotkeyScheme={hotkeyScheme}
            keyBindings={keyBindings}
            onPackagesChange={onUpdateSnippetPackages}
            onSave={(s) =>
              onUpdateSnippets(
                snippets.find((ex) => ex.id === s.id)
                  ? snippets.map((ex) => (ex.id === s.id ? s : ex))
                  : [...snippets, s],
              )
            }
            onBulkSave={onUpdateSnippets}
            onDelete={(id) =>
              onUpdateSnippets(snippets.filter((s) => s.id !== id))
            }
            onRunSnippet={onRunSnippet}
            availableKeys={keys}
            proxyProfiles={proxyProfiles}
            managedSources={managedSources}
            onSaveHost={(host) => onUpdateHosts([...hosts, host])}
            onCreateGroup={(groupPath) =>
              onUpdateCustomGroups(
                Array.from(new Set([...customGroups, groupPath])),
              )
            }
          />
        )}
        {currentSection === "keys" && (
          <KeychainManager
            keys={keys}
            identities={identities}
            hosts={hosts}
            proxyProfiles={proxyProfiles}
            customGroups={customGroups}
            groupConfigs={groupConfigs}
            managedSources={managedSources}
            onSave={(k) => onUpdateKeys([...keys, k])}
            onUpdate={(k) =>
              onUpdateKeys(
                keys.map((existing) => (existing.id === k.id ? k : existing)),
              )
            }
            onDelete={(id) => onUpdateKeys(keys.filter((k) => k.id !== id))}
            onSaveIdentity={(identity) =>
              onUpdateIdentities(
                identities.find((ex) => ex.id === identity.id)
                  ? identities.map((ex) =>
                    ex.id === identity.id ? identity : ex,
                  )
                  : [...identities, identity],
              )
            }
            onDeleteIdentity={(id) =>
              onUpdateIdentities(identities.filter((i) => i.id !== id))
            }
            onSaveHost={(host) => {
              // Update existing host or add new one
              const existingIndex = hosts.findIndex((h) => h.id === host.id);
              if (existingIndex >= 0) {
                onUpdateHosts(hosts.map((h) => (h.id === host.id ? host : h)));
              } else {
                onUpdateHosts([...hosts, host]);
              }
            }}
            onCreateGroup={(groupPath) =>
              onUpdateCustomGroups(
                Array.from(new Set([...customGroups, groupPath])),
              )
            }
          />
        )}
        {currentSection === "proxies" && (
          <ProxyProfilesManager
            proxyProfiles={proxyProfiles}
            hosts={hosts}
            groupConfigs={groupConfigs}
            onUpdateProxyProfiles={onUpdateProxyProfiles}
            onUpdateHosts={onUpdateHosts}
            onUpdateGroupConfigs={onUpdateGroupConfigs}
          />
        )}
        {currentSection === "port" && (
          <PortForwarding
            hosts={hosts}
            keys={keys}
            identities={identities}
            proxyProfiles={proxyProfiles}
            customGroups={customGroups}
            managedSources={managedSources}
            groupConfigs={groupConfigs}
            onSaveHost={(host) => onUpdateHosts([...hosts, host])}
            onCreateGroup={(groupPath) =>
              onUpdateCustomGroups(
                Array.from(new Set([...customGroups, groupPath])),
              )
            }
            terminalSettings={terminalSettings}
          />
        )}
        {/* Always render KnownHostsManager but hide with CSS to prevent unmounting */}
        <div
          style={{
            display: currentSection === "knownhosts" ? "contents" : "none",
          }}
        >
          {knownHostsManagerElement}
        </div>
        {/* Connection Logs */}
        {currentSection === "logs" && (
          <Suspense fallback={<div className="flex-1 flex items-center justify-center text-muted-foreground">Loading...</div>}>
            <LazyConnectionLogsManager
              logs={connectionLogs}
              hosts={hosts}
              onToggleSaved={onToggleConnectionLogSaved}
              onDelete={onDeleteConnectionLog}
              onClearUnsaved={onClearUnsavedConnectionLogs}
              onOpenLogView={onOpenLogView}
            />
          </Suspense>
        )}
      </div>

      {/* Group Details Panel */}
      {currentSection === "hosts" && isGroupPanelOpen && editingGroupPath && (
        <GroupDetailsPanel
          key={editingGroupPath}
          groupPath={editingGroupPath}
          config={groupConfigs.find(c => c.path === editingGroupPath)}
          availableKeys={keys}
          identities={identities}
          proxyProfiles={proxyProfiles}
          allHosts={hosts}
          groups={allGroupPaths}
          terminalThemeId={terminalThemeId}
          groupConfigs={groupConfigs}
          terminalFontSize={terminalFontSize}
          onSave={handleSaveGroupConfig}
          onCancel={() => {
            setIsGroupPanelOpen(false);
            setEditingGroupPath(null);
          }}
          layout="inline"
        />
      )}

      {/* Host Details Panel - positioned at VaultView root level for correct top alignment */}
      {currentSection === "hosts" && isHostPanelOpen && editingHost?.protocol !== 'serial' && (
        <HostDetailsPanel
          initialData={editingHost}
          availableKeys={keys}
          identities={identities}
          proxyProfiles={proxyProfiles}
          groups={allGroupPaths}
          managedSources={managedSources}
          allTags={allTags}
          allHosts={hosts}
          defaultGroup={editingHost ? undefined : (newHostGroupPath || selectedGroupPath)}
          terminalThemeId={terminalThemeId}
          terminalFontSize={terminalFontSize}
          groupDefaults={editingHostGroupDefaults}
          groupConfigs={groupConfigs}
          onImportKey={onImportOrReuseKey}
          onSave={(host) => {
            onUpdateHosts(upsertHostById(hosts, host));
            setIsHostPanelOpen(false);
            setEditingHost(null);
            setNewHostGroupPath(null);
          }}
          onCancel={() => {
            setIsHostPanelOpen(false);
            setEditingHost(null);
            setNewHostGroupPath(null);
          }}
          onCreateGroup={(groupPath) => {
            onUpdateCustomGroups(
              Array.from(new Set([...customGroups, groupPath])),
            );
          }}
          layout="inline"
        />
      )}

      {/* Serial Host Details Panel - for editing serial port hosts */}
      {currentSection === "hosts" && isHostPanelOpen && editingHost?.protocol === 'serial' && (
        <SerialHostDetailsPanel
          initialData={editingHost}
          allTags={allTags}
          groups={allGroupPaths}
          onSave={(host) => {
            onUpdateHosts(upsertHostById(hosts, host));
            setIsHostPanelOpen(false);
            setEditingHost(null);
            setNewHostGroupPath(null);
          }}
          onCancel={() => {
            setIsHostPanelOpen(false);
            setEditingHost(null);
            setNewHostGroupPath(null);
          }}
          layout="inline"
        />
      )}

      <Dialog open={isNewFolderOpen} onOpenChange={(open) => {
        setIsNewFolderOpen(open);
        if (!open) {
          setNewFolderName("");
          setTargetParentPath(null);
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {targetParentPath
                ? t("vault.groups.createSubfolder")
                : t("vault.groups.createRoot")}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {t("vault.groups.createDialog.desc")}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label>{t("vault.groups.field.name")}</Label>
            <Input
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder={t("vault.groups.placeholder.example")}
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && submitNewFolder()}
            />
            {targetParentPath && (
              <p className="text-xs text-muted-foreground mt-2">
                {t("vault.groups.parentLabel")}:{" "}
                <span className="font-mono">{targetParentPath}</span>
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setIsNewFolderOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={submitNewFolder}>{t("common.create")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={isRenameGroupOpen}
        onOpenChange={(open) => {
          setIsRenameGroupOpen(open);
          if (!open) {
            setRenameTargetPath(null);
            setRenameGroupName("");
            setRenameGroupError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("vault.groups.renameDialogTitle")}</DialogTitle>
            <DialogDescription className="sr-only">
              {t("vault.groups.renameDialog.desc")}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-2">
            <Label>{t("vault.groups.field.name")}</Label>
            <Input
              value={renameGroupName}
              onChange={(e) => {
                setRenameGroupName(e.target.value);
                setRenameGroupError(null);
              }}
              placeholder={t("vault.groups.placeholder.example")}
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && submitRenameGroup()}
            />
            {renameTargetPath && (
              <p className="text-xs text-muted-foreground">
                {t("vault.groups.pathLabel")}:{" "}
                <span className="font-mono">{renameTargetPath}</span>
              </p>
            )}
            {renameGroupError && (
              <p className="text-xs text-destructive">{renameGroupError}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setIsRenameGroupOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={submitRenameGroup}>{t("common.rename")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={isDeleteGroupOpen}
        onOpenChange={(open) => {
          setIsDeleteGroupOpen(open);
          if (!open) {
            setDeleteTargetPath(null);
            setDeleteGroupWithHosts(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("vault.groups.deleteDialogTitle")}</DialogTitle>
            <DialogDescription>
              {deleteTargetPath && managedGroupPaths.has(deleteTargetPath)
                ? t("vault.groups.deleteDialog.managedDesc")
                : t("vault.groups.deleteDialog.desc")}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-4">
            {deleteTargetPath && (
              <>
                <p className="text-sm text-muted-foreground">
                  {t("vault.groups.pathLabel")}:{" "}
                  <span className="font-mono">{deleteTargetPath}</span>
                </p>
                {!managedGroupPaths.has(deleteTargetPath) && (
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={deleteGroupWithHosts}
                      onChange={(e) => setDeleteGroupWithHosts(e.target.checked)}
                      className="rounded border-border"
                    />
                    <span>{t("vault.groups.deleteDialog.deleteHosts")}</span>
                  </label>
                )}
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setIsDeleteGroupOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleteTargetPath) {
                  const isManaged = managedGroupPaths.has(deleteTargetPath);
                  deleteGroupPath(deleteTargetPath, isManaged || deleteGroupWithHosts);
                }
                setIsDeleteGroupOpen(false);
                setDeleteGroupWithHosts(false);
              }}
            >
              {t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ImportVaultDialog
        open={isImportOpen}
        onOpenChange={setIsImportOpen}
        onFileSelected={handleImportFileSelected}
      />

      {/* Quick Connect Wizard */}
      {isQuickConnectOpen && quickConnectTarget && (
        <QuickConnectWizard
          open={isQuickConnectOpen}
          target={quickConnectTarget}
          keys={keys}
          onConnect={handleQuickConnect}
          onSaveHost={handleQuickConnectSaveHost}
          onClose={() => {
            setIsQuickConnectOpen(false);
            setQuickConnectTarget(null);
            setQuickConnectWarnings([]);
          }}
          warnings={quickConnectWarnings}
        />
      )}

      {/* Protocol Select Dialog */}
      {protocolSelectHost && (
        <Suspense fallback={null}>
          <LazyProtocolSelectDialog
            host={protocolSelectHost}
            onSelect={handleProtocolSelect}
            onCancel={() => setProtocolSelectHost(null)}
          />
        </Suspense>
      )}

      {/* Serial Connect Modal */}
      <SerialConnectModal
        open={isSerialModalOpen}
        onClose={() => setIsSerialModalOpen(false)}
        onConnect={(config, options) => {
          if (onConnectSerial) {
            onConnectSerial(config, options);
          }
        }}
        onSaveHost={(host) => {
          onUpdateHosts([...hosts, host]);
        }}
      />
    </div>
  );
}
