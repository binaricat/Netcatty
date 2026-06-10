import {
  AlertTriangle,
  ChevronDown,
  Copy,
  Globe,
  KeyRound,
  LayoutGrid,
  List as ListIcon,
  Pencil,
  Plus,
  Route,
  Settings2,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import React, { useMemo, useState } from "react";
import { useI18n } from "../application/i18n/I18nProvider";
import { useStoredViewMode } from "../application/state/useStoredViewMode";
import {
  formatProxyConfigEndpoint,
  isProxyCommandConfig,
  isValidProxyPort,
  removeProxyProfileReferences,
} from "../domain/proxyProfiles";
import {
  STORAGE_KEY_VAULT_PROXY_PROFILES_VIEW_MODE,
} from "../infrastructure/config/storageKeys";
import { cn } from "../lib/utils";
import type { GroupConfig, Host, ProxyConfig, ProxyProfile } from "../types";
import {
  AsidePanel,
  AsidePanelContent,
  AsidePanelFooter,
} from "./ui/aside-panel";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Dropdown, DropdownContent, DropdownTrigger } from "./ui/dropdown";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { toast } from "./ui/toast";
import {
  VaultHeaderSearch,
  VaultPageHeader,
  vaultHeaderIconButtonClass,
  vaultHeaderSecondaryButtonClass,
  vaultSectionTitleClass,
} from "./vault/VaultPageHeader";
import {
  VaultEntityIcon,
  vaultProxyCommandIconClass,
  vaultProxyHttpIconClass,
  vaultProxySocksIconClass,
} from "./vault/VaultEntityIcon";

interface ProxyProfilesManagerProps {
  proxyProfiles: ProxyProfile[];
  hosts: Host[];
  groupConfigs: GroupConfig[];
  onUpdateProxyProfiles: (profiles: ProxyProfile[]) => void;
  onUpdateHosts: (hosts: Host[]) => void;
  onUpdateGroupConfigs: (configs: GroupConfig[]) => void;
}

const createDraftProfile = (): ProxyProfile => {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    label: "",
    config: {
      type: "http",
      host: "",
      port: 8080,
    },
    createdAt: now,
    updatedAt: now,
  };
};

const getProfileUsageCount = (
  profileId: string,
  hosts: Host[],
  groupConfigs: GroupConfig[],
): number =>
  hosts.filter((host) => host.proxyProfileId === profileId).length +
  groupConfigs.filter((config) => config.proxyProfileId === profileId).length;

type ProxyProfilesViewMode = "grid" | "list";

const proxyProtocolMeta = {
  http: {
    label: "HTTP",
    Icon: Globe,
    iconClassName: vaultProxyHttpIconClass,
  },
  socks5: {
    label: "SOCKS5",
    Icon: Route,
    iconClassName: vaultProxySocksIconClass,
  },
  command: {
    labelKey: "hostDetails.proxyPanel.command",
    Icon: SquareTerminal,
    iconClassName: vaultProxyCommandIconClass,
  },
} satisfies Record<ProxyConfig["type"], {
  label?: string;
  labelKey?: string;
  Icon: React.ComponentType<{ size?: number; className?: string }>;
  iconClassName: string;
}>;

interface ProxyProfileCardProps {
  profile: ProxyProfile;
  usageCount: number;
  viewMode: ProxyProfilesViewMode;
  isSelected: boolean;
  onClick: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

const ProxyProfileCard: React.FC<ProxyProfileCardProps> = ({
  profile,
  usageCount,
  viewMode,
  isSelected,
  onClick,
  onEdit,
  onDuplicate,
  onDelete,
}) => {
  const { t } = useI18n();
  const usageLabel = t("proxyProfiles.usage", { count: usageCount });
  const protocol = proxyProtocolMeta[profile.config.type];
  const protocolLabel = protocol.labelKey ? t(protocol.labelKey) : protocol.label;
  const ProtocolIcon = protocol.Icon;
  const endpoint = formatProxyConfigEndpoint(profile.config);
  const accessibleLabel = `${profile.label}, ${protocolLabel}, ${endpoint}, ${usageLabel}`;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          aria-label={accessibleLabel}
          className={cn(
            "group w-full text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            viewMode === "grid"
              ? "soft-card elevate rounded-xl h-[68px] px-3 py-2"
              : "h-14 px-3 py-2 hover:bg-secondary/60 rounded-lg transition-colors",
            isSelected && "ring-2 ring-primary",
          )}
          onClick={onClick}
        >
          <div className="flex items-center gap-3 h-full">
            <VaultEntityIcon
              className={protocol.iconClassName}
              title={protocolLabel}
              icon={<ProtocolIcon size={18} />}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 min-w-0">
                <div className="text-sm font-semibold truncate">{profile.label}</div>
              </div>
              <div className="text-[11px] font-mono text-muted-foreground truncate">
                {endpoint} -{" "}
                {protocolLabel}
              </div>
            </div>
          </div>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onEdit}>
          <Pencil size={14} className="mr-2" />
          {t("action.edit")}
        </ContextMenuItem>
        <ContextMenuItem onClick={onDuplicate}>
          <Copy size={14} className="mr-2" />
          {t("action.duplicate")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onDelete} className="text-destructive focus:text-destructive">
          <Trash2 size={14} className="mr-2" />
          {t("action.delete")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
};

export const ProxyProfilesManager: React.FC<ProxyProfilesManagerProps> = ({
  proxyProfiles,
  hosts,
  groupConfigs,
  onUpdateProxyProfiles,
  onUpdateHosts,
  onUpdateGroupConfigs,
}) => {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useStoredViewMode(
    STORAGE_KEY_VAULT_PROXY_PROFILES_VIEW_MODE,
    "grid",
  );
  const proxyProfilesViewMode: ProxyProfilesViewMode =
    viewMode === "list" ? "list" : "grid";
  const [draft, setDraft] = useState<ProxyProfile | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProxyProfile | null>(null);

  const usageByProfileId = useMemo(() => {
    const map = new Map<string, number>();
    for (const profile of proxyProfiles) {
      map.set(profile.id, getProfileUsageCount(profile.id, hosts, groupConfigs));
    }
    return map;
  }, [groupConfigs, hosts, proxyProfiles]);

  const filteredProfiles = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return proxyProfiles;
    return proxyProfiles.filter((profile) =>
      profile.label.toLowerCase().includes(q) ||
      profile.config.host.toLowerCase().includes(q) ||
      (profile.config.command || "").toLowerCase().includes(q) ||
      profile.config.type.toLowerCase().includes(q),
    );
  }, [proxyProfiles, search]);

  const updateDraftConfig = (field: keyof ProxyConfig, value: string | number) => {
    setDraft((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        config: {
          ...prev.config,
          [field]: value,
        },
      };
    });
  };

  const openCreate = () => {
    setDraft(createDraftProfile());
  };

  const openEdit = (profile: ProxyProfile) => {
    setDraft({
      ...profile,
      config: { ...profile.config },
    });
  };

  const duplicateProfile = (profile: ProxyProfile) => {
    const now = Date.now();
    onUpdateProxyProfiles([
      ...proxyProfiles,
      {
        ...profile,
        id: crypto.randomUUID(),
        label: t("proxyProfiles.copyName", { name: profile.label }),
        config: { ...profile.config },
        createdAt: now,
        updatedAt: now,
      },
    ]);
  };

  const saveDraft = () => {
    if (!draft) return;
    const label = draft.label.trim();
    const host = draft.config.host.trim();
    const command = draft.config.command?.trim() || "";
    const isCommand = isProxyCommandConfig(draft.config);
    if (!label || (isCommand ? !command : (!host || !draft.config.port))) {
      toast.error(t("proxyProfiles.error.required"));
      return;
    }
    if (!isCommand && !isValidProxyPort(draft.config.port)) {
      toast.error(t("proxyProfiles.error.port"));
      return;
    }

    const saved: ProxyProfile = {
      ...draft,
      label,
      config: isCommand
        ? {
          type: "command",
          host: "",
          port: 0,
          command,
        }
        : {
          ...draft.config,
          host,
          port: Number(draft.config.port),
          username: draft.config.username?.trim() || undefined,
          password: draft.config.password || undefined,
        },
      updatedAt: Date.now(),
    };

    onUpdateProxyProfiles(
      proxyProfiles.some((profile) => profile.id === saved.id)
        ? proxyProfiles.map((profile) => profile.id === saved.id ? saved : profile)
        : [...proxyProfiles, saved],
    );
    setDraft(null);
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    const cleaned = removeProxyProfileReferences(deleteTarget.id, {
      hosts,
      groupConfigs,
    });
    onUpdateProxyProfiles(proxyProfiles.filter((profile) => profile.id !== deleteTarget.id));
    onUpdateHosts(cleaned.hosts);
    onUpdateGroupConfigs(cleaned.groupConfigs);
    if (draft?.id === deleteTarget.id) {
      setDraft(null);
    }
    setDeleteTarget(null);
  };

  return (
    <div className="h-full flex relative">
      <div className={cn("flex-1 flex flex-col min-h-0 transition-all duration-200", draft && "mr-[380px]")}>
        <VaultPageHeader>
            <Button
              onClick={openCreate}
              variant="secondary"
              className={vaultHeaderSecondaryButtonClass}
            >
              <Plus size={14} />
              {t("proxyProfiles.action.add")}
            </Button>
            <div className="ml-auto flex items-center gap-2 min-w-0 flex-shrink">
              <VaultHeaderSearch
                aria-label={t("proxyProfiles.search.placeholder")}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("proxyProfiles.search.placeholder")}
                className="flex-shrink w-64"
              />
              <Dropdown>
                <DropdownTrigger asChild>
                  <Button
                    aria-label={t("proxyProfiles.viewMode")}
                    variant="ghost"
                    size="icon"
                    className={cn(vaultHeaderIconButtonClass, "flex-shrink-0")}
                  >
                    {proxyProfilesViewMode === "grid" ? (
                      <LayoutGrid size={16} />
                    ) : (
                      <ListIcon size={16} />
                    )}
                    <ChevronDown size={10} className="ml-0.5" />
                  </Button>
                </DropdownTrigger>
                <DropdownContent className="w-32" align="end">
                  <Button
                    variant={proxyProfilesViewMode === "grid" ? "secondary" : "ghost"}
                    className="w-full justify-start gap-2 h-9"
                    onClick={() => setViewMode("grid")}
                  >
                    <LayoutGrid size={14} /> {t("vault.view.grid")}
                  </Button>
                  <Button
                    variant={proxyProfilesViewMode === "list" ? "secondary" : "ghost"}
                    className="w-full justify-start gap-2 h-9"
                    onClick={() => setViewMode("list")}
                  >
                    <ListIcon size={14} /> {t("vault.view.list")}
                  </Button>
                </DropdownContent>
              </Dropdown>
            </div>
        </VaultPageHeader>

        <div className="flex-1 overflow-y-auto">
          <div className="space-y-3 p-3">
            <div className="flex items-center justify-between">
              <h2 className={vaultSectionTitleClass}>
                {t("proxyProfiles.section.proxies")}
              </h2>
              <span className="text-xs text-muted-foreground">
                {t("proxyProfiles.count.items", { count: filteredProfiles.length })}
              </span>
            </div>

            {filteredProfiles.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
                <div className="h-16 w-16 rounded-2xl bg-secondary/80 flex items-center justify-center mb-4">
                  <Globe size={32} className="opacity-60" />
                </div>
                <h3 className="text-lg font-semibold text-foreground mb-2">
                  {t("proxyProfiles.empty.title")}
                </h3>
                <p className="text-sm text-center max-w-sm mb-4">
                  {t("proxyProfiles.empty.desc")}
                </p>
                <Button onClick={openCreate}>
                  <Plus size={14} className="mr-2" />
                  {t("proxyProfiles.action.add")}
                </Button>
              </div>
            ) : (
              <div
                className={
                  proxyProfilesViewMode === "grid"
                    ? "grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
                    : "flex flex-col gap-0"
                }
              >
                {filteredProfiles.map((profile) => (
                  <ProxyProfileCard
                    key={profile.id}
                    profile={profile}
                    usageCount={usageByProfileId.get(profile.id) ?? 0}
                    viewMode={proxyProfilesViewMode}
                    isSelected={draft?.id === profile.id}
                    onClick={() => openEdit(profile)}
                    onEdit={() => openEdit(profile)}
                    onDuplicate={() => duplicateProfile(profile)}
                    onDelete={() => setDeleteTarget(profile)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {draft && (
        <AsidePanel
          open={true}
          onClose={() => setDraft(null)}
          title={draft.label || t("proxyProfiles.panel.newTitle")}
        >
          <AsidePanelContent>
            <Card className="p-3 space-y-3 bg-card border-border/80">
              <div className="flex items-center gap-2">
                <Settings2 size={14} className="text-muted-foreground" />
                <p className="text-xs font-semibold">{t("proxyProfiles.field.name")}</p>
              </div>
              <Input
                aria-label={t("proxyProfiles.field.name")}
                value={draft.label}
                onChange={(event) => setDraft({ ...draft, label: event.target.value })}
                placeholder={t("proxyProfiles.field.name")}
                className="h-10"
              />
            </Card>

            <Card className="p-3 space-y-3 bg-card border-border/80">
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Globe size={14} className="text-muted-foreground" />
                  <p className="text-xs font-semibold">{t("field.type")}</p>
                </div>
                <Select
                  value={draft.config.type}
                  onValueChange={(value) => updateDraftConfig("type", value as ProxyConfig["type"])}
                >
                  <SelectTrigger aria-label={t("field.type")} className="h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="http">HTTP</SelectItem>
                    <SelectItem value="socks5">SOCKS5</SelectItem>
                    <SelectItem value="command">{t("hostDetails.proxyPanel.command")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {isProxyCommandConfig(draft.config) ? (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    {t("hostDetails.proxyPanel.commandHelp")}
                  </p>
                  <Input
                    aria-label={t("hostDetails.proxyPanel.commandPlaceholder")}
                    value={draft.config.command || ""}
                    onChange={(event) => updateDraftConfig("command", event.target.value)}
                    placeholder={t("hostDetails.proxyPanel.commandPlaceholder")}
                    className="h-10 font-mono text-xs"
                  />
                </div>
              ) : (
                <div className="flex gap-2">
                  <Input
                    aria-label={t("hostDetails.proxyPanel.hostPlaceholder")}
                    value={draft.config.host}
                    onChange={(event) => updateDraftConfig("host", event.target.value)}
                    placeholder={t("hostDetails.proxyPanel.hostPlaceholder")}
                    className="h-10 flex-1"
                  />
                  <Input
                    aria-label={t("hostDetails.port")}
                    type="number"
                    value={draft.config.port || ""}
                    onChange={(event) => updateDraftConfig("port", event.target.value === "" ? 0 : Number(event.target.value))}
                    placeholder="3128"
                    min={1}
                    max={65535}
                    step={1}
                    className="h-10 w-24 text-center"
                  />
                </div>
              )}
            </Card>

            {!isProxyCommandConfig(draft.config) && <Card className="p-3 space-y-3 bg-card border-border/80">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <KeyRound size={14} className="text-muted-foreground" />
                  <p className="text-xs font-semibold">{t("hostDetails.proxyPanel.credentials")}</p>
                </div>
                <Badge variant="secondary" className="text-xs">{t("common.optional")}</Badge>
              </div>
              <Input
                aria-label={t("hostDetails.proxyPanel.usernamePlaceholder")}
                value={draft.config.username || ""}
                onChange={(event) => updateDraftConfig("username", event.target.value)}
                placeholder={t("hostDetails.proxyPanel.usernamePlaceholder")}
                className="h-10"
              />
              <Input
                aria-label={t("hostDetails.proxyPanel.passwordPlaceholder")}
                type="password"
                value={draft.config.password || ""}
                onChange={(event) => updateDraftConfig("password", event.target.value)}
                placeholder={t("hostDetails.proxyPanel.passwordPlaceholder")}
                className="h-10"
              />
            </Card>}
          </AsidePanelContent>
          <AsidePanelFooter>
            <Button className="w-full" onClick={saveDraft}>
              {t("common.save")}
            </Button>
          </AsidePanelFooter>
        </AsidePanel>
      )}

      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle size={18} className="text-destructive" />
              {t("proxyProfiles.delete.title")}
            </DialogTitle>
            <DialogDescription>
              {deleteTarget
                ? t("proxyProfiles.delete.desc", {
                  name: deleteTarget.label,
                  count: usageByProfileId.get(deleteTarget.id) ?? 0,
                })
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              {t("common.cancel")}
            </Button>
            <Button variant="destructive" onClick={confirmDelete}>
              {t("action.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ProxyProfilesManager;
