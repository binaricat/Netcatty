/* eslint-disable @typescript-eslint/no-explicit-any */
import React from "react";

import { hostCardFocusClassName } from "../../domain/hostClickBehavior";
import { getVaultHostRowSubtitle } from "../../domain/localShellHost";
import type { Host } from "../../domain/models";
import { isPluginHostProtocol } from "../../domain/pluginConnection";
import {
  hasCompanionRdp,
  hasCompanionVnc,
  isRdpProtocol,
  isVncProtocol,
  type RemoteDesktopProtocol,
} from "../../domain/remoteDesktop";
import { isVaultHostDraggable } from "../../domain/vaultHostDrag";
import { HostNotesIndicator } from "../host/HostNotesIndicator";
import {
  CompanionRemoteDesktopMenuItems,
  OpenDualPaneSftpMenuItem,
  OpenHostBrowserMenuItem,
  OpenSystemRemoteDesktopMenuItems,
} from "../host/HostTreeContextMenus";
import { getProtocolBadgeClass } from "../protocolVisuals";
import { RdpProtocolIcon, VncProtocolIcon } from "../icons/RemoteDesktopIcons";

export type VaultHostCardSection = "pinned" | "recent" | "grouped" | "main";

export interface VaultHostCardPrimitives {
  Badge: React.ComponentType<any>;
  CheckSquare: React.ComponentType<any>;
  ClipboardCopy: React.ComponentType<any>;
  cn: (...inputs: any[]) => string;
  ContextMenu: React.ComponentType<any>;
  ContextMenuContent: React.ComponentType<any>;
  ContextMenuItem: React.ComponentType<any>;
  ContextMenuTrigger: React.ComponentType<any>;
  Copy: React.ComponentType<any>;
  DistroAvatar: React.ComponentType<any>;
  Edit2: React.ComponentType<any>;
  Pin: React.ComponentType<any>;
  Plug: React.ComponentType<any>;
  Square: React.ComponentType<any>;
  Star: React.ComponentType<any>;
  Trash2: React.ComponentType<any>;
}

export interface VaultHostContextMenuProps {
  host: Host;
  section: VaultHostCardSection;
  primitives: Pick<
    VaultHostCardPrimitives,
    | "ClipboardCopy"
    | "ContextMenuContent"
    | "ContextMenuItem"
    | "Copy"
    | "Edit2"
    | "Pin"
    | "Plug"
    | "Trash2"
  >;
  t: (key: string, params?: Record<string, unknown>) => string;
  onConnect: (host: Host) => void;
  onConnectRemoteDesktop?: (host: Host, protocol: RemoteDesktopProtocol) => void;
  onOpenSystemRemoteDesktop?: (host: Host, protocol: RemoteDesktopProtocol) => void;
  onOpenBrowser?: (host: Host) => void;
  onEdit: (host: Host) => void;
  onDuplicate: (host: Host) => void;
  onCopyHostname: (host: Host) => void;
  onCopyCredentials: (host: Host) => void;
  onTogglePinned: (hostId: string) => void;
  onDelete: (hostId: string) => void;
}

export const VaultHostContextMenu: React.FC<VaultHostContextMenuProps> = ({
  host,
  section,
  primitives,
  t,
  onConnect,
  onConnectRemoteDesktop,
  onOpenSystemRemoteDesktop,
  onOpenBrowser,
  onEdit,
  onDuplicate,
  onCopyHostname,
  onCopyCredentials,
  onTogglePinned,
  onDelete,
}) => {
  const {
    ClipboardCopy,
    ContextMenuContent,
    ContextMenuItem,
    Copy,
    Edit2,
    Pin,
    Plug,
    Trash2,
  } = primitives;
  const pinLabel = section === "pinned" || host.pinned
    ? t("vault.hosts.unpin")
    : t("vault.hosts.pinToTop");

  return (
    <ContextMenuContent>
      <ContextMenuItem onClick={() => onConnect(host)}>
        <Plug className="mr-2 h-4 w-4" /> {t("vault.hosts.connect")}
      </ContextMenuItem>
      <OpenDualPaneSftpMenuItem host={host} />
      <CompanionRemoteDesktopMenuItems
        host={host}
        onConnect={onConnect}
        onConnectRemoteDesktop={onConnectRemoteDesktop}
      />
      <OpenHostBrowserMenuItem host={host} onOpenBrowser={onOpenBrowser} />
      <OpenSystemRemoteDesktopMenuItems
        host={host}
        onOpenSystemRemoteDesktop={onOpenSystemRemoteDesktop}
      />
      <ContextMenuItem onClick={() => onEdit(host)}>
        <Edit2 className="mr-2 h-4 w-4" /> {t("action.edit")}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onDuplicate(host)}>
        <Copy className="mr-2 h-4 w-4" /> {t("action.duplicate")}
      </ContextMenuItem>
      {!isPluginHostProtocol(host.protocol) ? (
        <ContextMenuItem onClick={() => onCopyHostname(host)}>
          <Copy className="mr-2 h-4 w-4" /> {t("terminal.statusbar.copyHostname.label")}
        </ContextMenuItem>
      ) : null}
      <ContextMenuItem onClick={() => onCopyCredentials(host)}>
        <ClipboardCopy className="mr-2 h-4 w-4" /> {t("vault.hosts.copyCredentials")}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onTogglePinned(host.id)}>
        <Pin className="mr-2 h-4 w-4" /> {pinLabel}
      </ContextMenuItem>
      <ContextMenuItem className="text-destructive" onClick={() => onDelete(host.id)}>
        <Trash2 className="mr-2 h-4 w-4" /> {t("action.delete")}
      </ContextMenuItem>
    </ContextMenuContent>
  );
};

export interface VaultHostCardProps {
  host: Host;
  section: VaultHostCardSection;
  gridItemKey: string;
  viewMode: "list" | "grid";
  isMultiSelectMode: boolean;
  selectedHostIds: ReadonlySet<string>;
  draggingHostIds: ReadonlySet<string> | null;
  isFocusSelected: boolean;
  tabIndex: number;
  isPopInAnimated?: boolean;
  onPopInAnimationEnd?: () => void;
  sanitizeHost: (host: Host) => Host;
  getEffectiveHostDistro: (host: Host) => string | undefined;
  renderEditButton: (host: Host, compact?: boolean) => React.ReactNode;
  onDragStart: (e: React.DragEvent, hostId: string) => void;
  onActivate: (safeHost: Host) => void;
  onConnect: (host: Host) => void;
  onConnectRemoteDesktop?: (host: Host, protocol: RemoteDesktopProtocol) => void;
  onOpenSystemRemoteDesktop?: (host: Host, protocol: RemoteDesktopProtocol) => void;
  onOpenBrowser?: (host: Host) => void;
  onEdit: (host: Host) => void;
  onDuplicate: (host: Host) => void;
  onCopyHostname: (host: Host) => void;
  onCopyCredentials: (host: Host) => void;
  onTogglePinned: (hostId: string) => void;
  onDelete: (hostId: string) => void;
  t: (key: string, params?: Record<string, unknown>) => string;
  primitives: VaultHostCardPrimitives;
}

export const VaultHostCard: React.FC<VaultHostCardProps> = ({
  host,
  section,
  gridItemKey,
  viewMode,
  isMultiSelectMode,
  selectedHostIds,
  draggingHostIds,
  isFocusSelected,
  tabIndex,
  isPopInAnimated = false,
  onPopInAnimationEnd,
  sanitizeHost,
  getEffectiveHostDistro,
  renderEditButton,
  onDragStart,
  onActivate,
  onConnect,
  onConnectRemoteDesktop,
  onOpenSystemRemoteDesktop,
  onOpenBrowser,
  onEdit,
  onDuplicate,
  onCopyHostname,
  onCopyCredentials,
  onTogglePinned,
  onDelete,
  t,
  primitives,
}) => {
  const {
    Badge,
    CheckSquare,
    cn,
    ContextMenu,
    ContextMenuTrigger,
    DistroAvatar,
    Square,
    Star,
  } = primitives;

  const safeHost = sanitizeHost(host);
  const effectiveDistro = getEffectiveHostDistro(safeHost);
  const isStandaloneRdp = isRdpProtocol(safeHost.protocol);
  const isStandaloneVnc = isVncProtocol(safeHost.protocol);
  const companionRdp = hasCompanionRdp(safeHost);
  const companionVnc = hasCompanionVnc(safeHost);
  const distroBadge = {
    text: (safeHost.os || "L")[0].toUpperCase(),
    label: effectiveDistro || safeHost.os || "Linux",
  };
  const showGridStar = viewMode === "grid"
    && (section === "pinned" || (section !== "recent" && Boolean(host.pinned)));
  const showManagedBadge = (section === "grouped" || section === "main")
    && Boolean(safeHost.managedSourceId);
  const checkboxAriaHidden = section === "grouped" || section === "main" ? true : undefined;

  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <div
          className={cn(
            "vault-drop-indicator-row group cursor-pointer relative",
            viewMode === "grid"
              ? cn(
                "soft-card elevate rounded-xl h-[68px] px-3 py-2 will-change-transform transition-[opacity,box-shadow,border-color,background-color] duration-150",
                draggingHostIds?.has(host.id) && "opacity-45",
                hostCardFocusClassName(viewMode, isFocusSelected),
              )
              : cn(
                "h-14 px-2 py-2 rounded-lg transition-colors",
                isFocusSelected
                  ? hostCardFocusClassName("list", true)
                  : "hover:bg-secondary/60",
              ),
          )}
          data-host-id={host.id}
          data-vault-grid-item={gridItemKey}
          role={isMultiSelectMode ? "checkbox" : "button"}
          aria-checked={isMultiSelectMode ? selectedHostIds.has(host.id) : undefined}
          tabIndex={tabIndex}
          style={isPopInAnimated
            ? { animation: "pop-in 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) both" }
            : undefined}
          onAnimationEnd={onPopInAnimationEnd}
          draggable={isVaultHostDraggable(Boolean(isMultiSelectMode), selectedHostIds, host.id)}
          onDragStart={(e) => onDragStart(e, host.id)}
          onClick={() => {
            onActivate(safeHost);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            onActivate(safeHost);
          }}
        >
          {showGridStar && (
            <Star size={10} className="absolute top-1.5 right-1.5 text-amber-400 fill-amber-400" />
          )}
          <div className="flex items-center gap-3 h-full">
            {isMultiSelectMode && (
              <div className="shrink-0" aria-hidden={checkboxAriaHidden}>
                {selectedHostIds.has(host.id) ? (
                  <CheckSquare size={18} className="text-primary" />
                ) : (
                  <Square size={18} className="text-muted-foreground" />
                )}
              </div>
            )}
            <DistroAvatar host={safeHost} fallback={distroBadge.text} size="lg" />
            <div className="min-w-0 flex flex-col justify-center gap-0.5 flex-1">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-sm font-semibold truncate leading-5 min-w-0">
                  {safeHost.label}
                </span>
                {viewMode !== "grid" && (
                  <>
                    {isStandaloneRdp && (
                      <span
                        className={cn(
                          "inline-flex items-center gap-0.5 rounded-md border px-1.5 py-0 text-[10px] font-semibold leading-4 shrink-0",
                          getProtocolBadgeClass("rdp"),
                        )}
                      >
                        <RdpProtocolIcon size={10} />
                        RDP
                      </span>
                    )}
                    {isStandaloneVnc && (
                      <span
                        className={cn(
                          "inline-flex items-center gap-0.5 rounded-md border px-1.5 py-0 text-[10px] font-semibold leading-4 shrink-0",
                          getProtocolBadgeClass("vnc"),
                        )}
                      >
                        <VncProtocolIcon size={10} />
                        VNC
                      </span>
                    )}
                    {companionRdp && (
                      <button
                        type="button"
                        title={t("vault.hosts.connectRdp")}
                        className={cn(
                          "inline-flex items-center gap-0.5 rounded-md border px-1.5 py-0 text-[10px] font-semibold leading-4 shrink-0 transition-all hover:brightness-110 hover:shadow-sm",
                          getProtocolBadgeClass("rdp"),
                        )}
                        onClick={(e) => {
                          e.stopPropagation();
                          onConnectRemoteDesktop?.(safeHost, "rdp");
                        }}
                      >
                        <RdpProtocolIcon size={10} />
                        +RDP
                      </button>
                    )}
                    {companionVnc && (
                      <button
                        type="button"
                        title={t("vault.hosts.connectVnc")}
                        className={cn(
                          "inline-flex items-center gap-0.5 rounded-md border px-1.5 py-0 text-[10px] font-semibold leading-4 shrink-0 transition-all hover:brightness-110 hover:shadow-sm",
                          getProtocolBadgeClass("vnc"),
                        )}
                        onClick={(e) => {
                          e.stopPropagation();
                          onConnectRemoteDesktop?.(safeHost, "vnc");
                        }}
                      >
                        <VncProtocolIcon size={10} />
                        +VNC
                      </button>
                    )}
                    {renderEditButton(host, true)}
                  </>
                )}
                {showManagedBadge && (
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 shrink-0">
                    managed
                  </Badge>
                )}
                <HostNotesIndicator notes={safeHost.notes} />
              </div>
              <div className="flex items-center gap-1.5 min-w-0">
                <div className="text-[11px] text-muted-foreground font-mono truncate leading-4 min-w-0 flex-1">
                  {getVaultHostRowSubtitle(safeHost, { localFallback: t("localShell.subtitle") })}
                </div>
                {viewMode === "grid" && (isStandaloneRdp || isStandaloneVnc || companionRdp || companionVnc) && (
                  <div className="flex items-center gap-1 shrink-0">
                    {isStandaloneRdp && (
                      <span
                        className={cn(
                          "inline-flex items-center gap-0.5 rounded border px-1 py-0 text-[9.5px] font-semibold leading-[15px] shrink-0",
                          getProtocolBadgeClass("rdp"),
                        )}
                      >
                        <RdpProtocolIcon size={9} />
                        RDP
                      </span>
                    )}
                    {isStandaloneVnc && (
                      <span
                        className={cn(
                          "inline-flex items-center gap-0.5 rounded border px-1 py-0 text-[9.5px] font-semibold leading-[15px] shrink-0",
                          getProtocolBadgeClass("vnc"),
                        )}
                      >
                        <VncProtocolIcon size={9} />
                        VNC
                      </span>
                    )}
                    {companionRdp && (
                      <button
                        type="button"
                        title={t("vault.hosts.connectRdp")}
                        className={cn(
                          "inline-flex items-center gap-0.5 rounded border px-1 py-0 text-[9.5px] font-semibold leading-[15px] shrink-0 transition-all hover:brightness-110",
                          getProtocolBadgeClass("rdp"),
                        )}
                        onClick={(e) => {
                          e.stopPropagation();
                          onConnectRemoteDesktop?.(safeHost, "rdp");
                        }}
                      >
                        <RdpProtocolIcon size={9} />
                        +RDP
                      </button>
                    )}
                    {companionVnc && (
                      <button
                        type="button"
                        title={t("vault.hosts.connectVnc")}
                        className={cn(
                          "inline-flex items-center gap-0.5 rounded border px-1 py-0 text-[9.5px] font-semibold leading-[15px] shrink-0 transition-all hover:brightness-110",
                          getProtocolBadgeClass("vnc"),
                        )}
                        onClick={(e) => {
                          e.stopPropagation();
                          onConnectRemoteDesktop?.(safeHost, "vnc");
                        }}
                      >
                        <VncProtocolIcon size={9} />
                        +VNC
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
            {viewMode === "grid" && renderEditButton(host)}
          </div>
        </div>
      </ContextMenuTrigger>
      <VaultHostContextMenu
        host={host}
        section={section}
        primitives={primitives}
        t={t}
        onConnect={onConnect}
        onConnectRemoteDesktop={onConnectRemoteDesktop}
        onOpenSystemRemoteDesktop={onOpenSystemRemoteDesktop}
        onOpenBrowser={onOpenBrowser}
        onEdit={onEdit}
        onDuplicate={onDuplicate}
        onCopyHostname={onCopyHostname}
        onCopyCredentials={onCopyCredentials}
        onTogglePinned={onTogglePinned}
        onDelete={onDelete}
      />
    </ContextMenu>
  );
};
