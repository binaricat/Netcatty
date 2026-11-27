import {
  AlertTriangle,
  Calendar,
  Check,
  Copy,
  Eye,
  Fingerprint,
  Server,
  Shield,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import React, { memo, useCallback, useMemo, useState } from "react";
import { useI18n } from "../../application/i18n/I18nProvider";
import type { ViewMode } from "../../application/state/useStoredViewMode";
import { formatHostPort } from "../../domain/host";
import { cn } from "../../lib/utils";
import { RdpProtocolIcon, VncProtocolIcon } from "../icons/RemoteDesktopIcons";
import { getProtocolBadgeClass } from "../protocolVisuals";
import type { KnownRemoteDesktopCertEntry } from "../remoteDesktop/knownRemoteDesktopCerts";
import { Button } from "../ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import type { SortMode } from "../ui/sort-dropdown";
import { toast } from "../ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

export interface RemoteDesktopCertListProps {
  certs: KnownRemoteDesktopCertEntry[];
  search: string;
  viewMode: ViewMode;
  sortMode: SortMode;
  onRequestRevoke: (cert: KnownRemoteDesktopCertEntry) => void;
}

const certActionButtonClass =
  "h-8 w-8 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100";

export function isRemoteDesktopCertExpired(validTo?: string, now = Date.now()): boolean {
  if (!validTo) return false;
  const parsed = Date.parse(validTo);
  return !Number.isNaN(parsed) && parsed < now;
}

export function truncateFingerprint(fingerprint: string, maxLen = 29): string {
  if (fingerprint.length <= maxLen) return fingerprint;
  const head = Math.max(8, Math.floor((maxLen - 1) / 2));
  const tail = Math.max(6, maxLen - head - 1);
  return `${fingerprint.slice(0, head)}…${fingerprint.slice(-tail)}`;
}

export function filterAndSortRemoteDesktopCerts(
  certs: KnownRemoteDesktopCertEntry[],
  search: string,
  sortMode: SortMode,
): KnownRemoteDesktopCertEntry[] {
  const term = search.trim().toLowerCase();
  let result = term
    ? certs.filter((cert) => (
        cert.host.toLowerCase().includes(term)
        || cert.protocol.toLowerCase().includes(term)
        || String(cert.port).includes(term)
        || cert.fingerprintSha256.toLowerCase().includes(term)
        || (cert.subject?.toLowerCase().includes(term) ?? false)
        || (cert.issuer?.toLowerCase().includes(term) ?? false)
      ))
    : [...certs];

  result = [...result].sort((a, b) => {
    switch (sortMode) {
      case "az":
        return a.host.localeCompare(b.host) || a.port - b.port;
      case "za":
        return b.host.localeCompare(a.host) || b.port - a.port;
      case "oldest":
        return a.trustedAt - b.trustedAt;
      case "newest":
      case "manual":
      default:
        return b.trustedAt - a.trustedAt || a.host.localeCompare(b.host);
    }
  });

  return result;
}

const formatTimestamp = (timestamp: number, locale: string): string => {
  if (!timestamp) return "—";
  try {
    return new Date(timestamp).toLocaleString(locale || undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return new Date(timestamp).toISOString();
  }
};

interface CertItemProps {
  cert: KnownRemoteDesktopCertEntry;
  viewMode: ViewMode;
  copiedKey: string | null;
  onCopy: (cert: KnownRemoteDesktopCertEntry) => void;
  onInspect: (cert: KnownRemoteDesktopCertEntry) => void;
  onRevoke: (cert: KnownRemoteDesktopCertEntry) => void;
}

const CertItem = memo<CertItemProps>(({
  cert,
  viewMode,
  copiedKey,
  onCopy,
  onInspect,
  onRevoke,
}) => {
  const { t } = useI18n();
  const isRdp = cert.protocol === "rdp";
  const expired = isRemoteDesktopCertExpired(cert.validTo);
  const endpoint = formatHostPort(cert.host, cert.port);
  const copied = copiedKey === cert.key;

  const iconEl = (
    <div
      className={cn(
        "h-9 w-9 rounded-xl flex items-center justify-center shrink-0",
        isRdp
          ? "bg-blue-500/12 text-blue-600 dark:text-blue-400"
          : "bg-teal-500/12 text-teal-600 dark:text-teal-400",
      )}
    >
      {isRdp ? <RdpProtocolIcon size={18} /> : <VncProtocolIcon size={18} />}
    </div>
  );

  const actionsEl = (
    <div className="flex shrink-0 items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={certActionButtonClass}
            aria-label={t("knownHosts.certs.action.copyFingerprint")}
            onClick={(e) => {
              e.stopPropagation();
              onCopy(cert);
            }}
          >
            {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {copied ? t("knownHosts.certs.copied") : t("knownHosts.certs.action.copyFingerprint")}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              certActionButtonClass,
              "text-destructive hover:text-destructive hover:bg-destructive/10",
            )}
            aria-label={t("knownHosts.certs.action.revoke")}
            onClick={(e) => {
              e.stopPropagation();
              onRevoke(cert);
            }}
          >
            <Trash2 size={14} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("knownHosts.certs.action.revoke")}</TooltipContent>
      </Tooltip>
    </div>
  );

  const menuContent = (
    <ContextMenuContent>
      <ContextMenuItem onClick={() => onInspect(cert)}>
        <Eye className="mr-2 h-4 w-4" />
        {t("knownHosts.certs.action.inspect")}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onCopy(cert)}>
        <Copy className="mr-2 h-4 w-4" />
        {t("knownHosts.certs.action.copyFingerprint")}
      </ContextMenuItem>
      <ContextMenuItem className="text-destructive" onClick={() => onRevoke(cert)}>
        <Trash2 className="mr-2 h-4 w-4" />
        {t("knownHosts.certs.action.revoke")}
      </ContextMenuItem>
    </ContextMenuContent>
  );

  if (viewMode === "grid") {
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            role="button"
            tabIndex={0}
            data-cert-key={cert.key}
            className="group cursor-pointer soft-card elevate rounded-xl min-h-[76px] px-3 py-2.5 text-left"
            onClick={() => onInspect(cert)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onInspect(cert);
              }
            }}
          >
            <div className="flex items-center gap-3 h-full">
              {iconEl}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-sm font-semibold truncate">{endpoint}</span>
                  <span
                    className={cn(
                      "inline-flex items-center rounded-md border px-1.5 py-0 text-[10px] font-semibold uppercase leading-4 shrink-0",
                      getProtocolBadgeClass(cert.protocol),
                    )}
                  >
                    {cert.protocol.toUpperCase()}
                  </span>
                  {expired && (
                    <span className="inline-flex items-center gap-0.5 rounded-md border border-amber-500/40 bg-amber-500/12 px-1.5 py-0 text-[10px] font-medium text-amber-600 dark:text-amber-400 shrink-0">
                      <AlertTriangle size={10} />
                      {t("knownHosts.certs.expired")}
                    </span>
                  )}
                </div>
                <div
                  className="mt-0.5 font-mono text-[11px] text-muted-foreground truncate"
                  title={cert.fingerprintSha256}
                >
                  {truncateFingerprint(cert.fingerprintSha256, 26)}
                </div>
              </div>
              {actionsEl}
            </div>
          </div>
        </ContextMenuTrigger>
        {menuContent}
      </ContextMenu>
    );
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          data-cert-key={cert.key}
          className="group flex items-center gap-3 px-3 py-2 h-14 rounded-lg hover:bg-secondary/60 transition-colors cursor-pointer"
          onClick={() => onInspect(cert)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onInspect(cert);
            }
          }}
        >
          {iconEl}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-sm font-semibold truncate">{endpoint}</span>
              <span
                className={cn(
                  "inline-flex items-center rounded-md border px-1.5 py-0 text-[10px] font-semibold uppercase leading-4 shrink-0",
                  getProtocolBadgeClass(cert.protocol),
                )}
              >
                {cert.protocol.toUpperCase()}
              </span>
              {expired && (
                <span className="inline-flex items-center gap-0.5 rounded-md border border-amber-500/40 bg-amber-500/12 px-1.5 py-0 text-[10px] font-medium text-amber-600 dark:text-amber-400 shrink-0">
                  <AlertTriangle size={10} />
                  {t("knownHosts.certs.expired")}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground min-w-0">
              <span className="font-mono truncate" title={cert.fingerprintSha256}>
                {truncateFingerprint(cert.fingerprintSha256, 44)}
              </span>
              {cert.subject && (
                <span className="truncate opacity-80 hidden sm:inline">
                  · {cert.subject}
                </span>
              )}
            </div>
          </div>
          {actionsEl}
        </div>
      </ContextMenuTrigger>
      {menuContent}
    </ContextMenu>
  );
});

CertItem.displayName = "CertItem";

export const RemoteDesktopCertList: React.FC<RemoteDesktopCertListProps> = memo(({
  certs,
  search,
  viewMode,
  sortMode,
  onRequestRevoke,
}) => {
  const { t, resolvedLocale } = useI18n();
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [inspectedCert, setInspectedCert] = useState<KnownRemoteDesktopCertEntry | null>(null);

  const filteredCerts = useMemo(
    () => filterAndSortRemoteDesktopCerts(certs, search, sortMode),
    [certs, search, sortMode],
  );

  const handleCopyFingerprint = useCallback((cert: KnownRemoteDesktopCertEntry) => {
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clipboard?.writeText) return;
    void clipboard.writeText(cert.fingerprintSha256).then(() => {
      setCopiedKey(cert.key);
      toast.success(t("knownHosts.certs.copied"), formatHostPort(cert.host, cert.port));
      window.setTimeout(() => {
        setCopiedKey((current) => (current === cert.key ? null : current));
      }, 1800);
    }).catch(() => {});
  }, [t]);

  const handleInspect = useCallback((cert: KnownRemoteDesktopCertEntry) => {
    setInspectedCert(cert);
  }, []);

  const inspectedExpired = inspectedCert ? isRemoteDesktopCertExpired(inspectedCert.validTo) : false;

  return (
    <>
      <div
        data-section="known-remote-desktop-certs"
        className={cn(
          "p-4",
          viewMode === "grid"
            ? "grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3"
            : "flex flex-col gap-0",
        )}
      >
        {filteredCerts.length === 0 ? (
          <div
            className={cn(
              "flex flex-col items-center justify-center py-16 text-muted-foreground",
              viewMode === "grid" && "col-span-full",
            )}
          >
            <div className="h-16 w-16 rounded-2xl bg-secondary/80 flex items-center justify-center mb-4">
              <ShieldCheck size={32} className="opacity-60" />
            </div>
            <h3 className="text-lg font-semibold text-foreground mb-2">
              {certs.length === 0
                ? t("knownHosts.certs.empty.title")
                : t("knownHosts.certs.empty.searchTitle")}
            </h3>
            <p className="text-sm text-center max-w-sm">
              {certs.length === 0
                ? t("knownHosts.certs.empty.desc")
                : t("knownHosts.certs.empty.searchDesc")}
            </p>
          </div>
        ) : (
          filteredCerts.map((cert) => (
            <CertItem
              key={cert.key}
              cert={cert}
              viewMode={viewMode}
              copiedKey={copiedKey}
              onCopy={handleCopyFingerprint}
              onInspect={handleInspect}
              onRevoke={onRequestRevoke}
            />
          ))
        )}
      </div>

      <Dialog
        open={Boolean(inspectedCert)}
        onOpenChange={(open) => {
          if (!open) setInspectedCert(null);
        }}
      >
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-[520px]">
          {inspectedCert && (
            <>
              <DialogHeader className="min-w-0 pr-6">
                <DialogTitle className="flex items-center gap-2 min-w-0">
                  <span
                    className={cn(
                      "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
                      inspectedCert.protocol === "rdp"
                        ? "bg-blue-500/12 text-blue-600 dark:text-blue-400"
                        : "bg-teal-500/12 text-teal-600 dark:text-teal-400",
                    )}
                  >
                    {inspectedCert.protocol === "rdp" ? (
                      <RdpProtocolIcon size={16} />
                    ) : (
                      <VncProtocolIcon size={16} />
                    )}
                  </span>
                  <span className="truncate">
                    {formatHostPort(inspectedCert.host, inspectedCert.port)}
                  </span>
                  <span
                    className={cn(
                      "inline-flex items-center rounded-md border px-1.5 py-0 text-[10px] font-semibold uppercase leading-4 shrink-0",
                      getProtocolBadgeClass(inspectedCert.protocol),
                    )}
                  >
                    {inspectedCert.protocol.toUpperCase()}
                  </span>
                </DialogTitle>
                <DialogDescription>
                  {t("knownHosts.certs.detail.subtitle")}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-3 text-xs">
                {inspectedExpired && (
                  <div className="flex items-center gap-2 rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-amber-700 dark:text-amber-300">
                    <AlertTriangle size={14} className="shrink-0" />
                    <span>{t("knownHosts.certs.expiredNotice")}</span>
                  </div>
                )}

                <div className="rounded-lg border border-border/70 bg-secondary/45 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                      <Fingerprint size={13} className="text-primary" />
                      {t("knownHosts.certs.detail.fingerprint")}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 gap-1 px-2 text-[11px]"
                      onClick={() => handleCopyFingerprint(inspectedCert)}
                    >
                      {copiedKey === inspectedCert.key ? (
                        <Check size={12} className="text-emerald-500" />
                      ) : (
                        <Copy size={12} />
                      )}
                      {copiedKey === inspectedCert.key
                        ? t("knownHosts.certs.copied")
                        : t("knownHosts.certs.action.copyFingerprint")}
                    </Button>
                  </div>
                  <code className="mt-1.5 block break-all font-mono text-[11px] leading-5 text-foreground select-all">
                    {inspectedCert.fingerprintSha256}
                  </code>
                </div>

                <div className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-2 rounded-lg border border-border/60 bg-background/60 p-3 text-[11px]">
                  <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                    <Server size={11} className="shrink-0" />
                    {t("knownHosts.certs.detail.subject")}
                  </span>
                  <span className="font-mono break-all text-foreground">
                    {inspectedCert.subject || "—"}
                  </span>

                  <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                    <Shield size={11} className="shrink-0" />
                    {t("knownHosts.certs.detail.issuer")}
                  </span>
                  <span className="font-mono break-all text-foreground">
                    {inspectedCert.issuer || "—"}
                  </span>

                  <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                    <Calendar size={11} className="shrink-0" />
                    {t("knownHosts.certs.detail.validFrom")}
                  </span>
                  <span className="text-foreground">
                    {inspectedCert.validFrom || "—"}
                  </span>

                  <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                    <Calendar size={11} className="shrink-0" />
                    {t("knownHosts.certs.detail.validTo")}
                  </span>
                  <span className={cn("text-foreground", inspectedExpired && "text-amber-600 dark:text-amber-400 font-medium")}>
                    {inspectedCert.validTo || "—"}
                  </span>

                  <span className="text-muted-foreground">
                    {t("knownHosts.certs.detail.trustedAt")}
                  </span>
                  <span className="text-foreground">
                    {formatTimestamp(inspectedCert.trustedAt, resolvedLocale)}
                  </span>

                  <span className="text-muted-foreground">
                    {t("knownHosts.certs.detail.lastSeen")}
                  </span>
                  <span className="text-foreground">
                    {formatTimestamp(inspectedCert.lastSeenAt, resolvedLocale)}
                  </span>
                </div>
              </div>

              <DialogFooter className="gap-2 sm:gap-0">
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => {
                    const target = inspectedCert;
                    setInspectedCert(null);
                    onRequestRevoke(target);
                  }}
                >
                  <Trash2 size={13} />
                  {t("knownHosts.certs.action.revoke")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setInspectedCert(null)}
                >
                  {t("common.close")}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
});

RemoteDesktopCertList.displayName = "RemoteDesktopCertList";
