import {
  BadgeCheck,
  ChevronDown,
  ChevronRight,
  Edit2,
  Info,
  Key,
  LayoutGrid,
  List as ListIcon,
  MoreHorizontal,
  Plus,
  Search,
  Shield,
  Trash2,
  Upload,
  UserPlus,
} from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";
import { useI18n } from "../application/i18n/I18nProvider";
import { useStoredViewMode } from "../application/state/useStoredViewMode";
import { resolveHostAuth } from "../domain/sshAuth";
import { STORAGE_KEY_VAULT_KEYS_VIEW_MODE } from "../infrastructure/config/storageKeys";
import { logger } from "../lib/logger";
import { cn } from "../lib/utils";
import { Host, Identity, KeyType, SSHKey } from "../types";
import { ManagedSource } from "../domain/models";
import { useKeychainBackend } from "../application/state/useKeychainBackend";
import SelectHostPanel from "./SelectHostPanel";
import {
  AsideActionMenu,
  AsideActionMenuItem,
  AsidePanel,
  AsidePanelContent,
} from "./ui/aside-panel";
import { Button } from "./ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./ui/context-menu";
import { Dropdown, DropdownContent, DropdownTrigger } from "./ui/dropdown";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { toast } from "./ui/toast";

// Import utilities and components from keychain module
import {
  type FilterTab,
  GenerateStandardPanel,
  IdentityCard,
  IdentityPanel,
  ImportKeyPanel,
  isMacOS,
  KeyCard,
  type PanelMode,
  ViewKeyPanel,
} from "./keychain";

interface KeychainManagerProps {
  keys: SSHKey[];
  identities?: Identity[];
  hosts?: Host[];
  customGroups?: string[];
  managedSources?: ManagedSource[];
  onSave: (key: SSHKey) => void;
  onUpdate: (key: SSHKey) => void;
  onDelete: (id: string) => void;
  onSaveIdentity?: (identity: Identity) => void;
  onDeleteIdentity?: (id: string) => void;
  onNewHost?: () => void;
  onSaveHost?: (host: Host) => void;
  onCreateGroup?: (groupPath: string) => void;
}

const KeychainManager: React.FC<KeychainManagerProps> = ({
  keys,
  identities = [],
  hosts = [],
  customGroups = [],
  managedSources = [],
  onSave,
  onUpdate,
  onDelete,
  onSaveIdentity,
  onDeleteIdentity,
  onNewHost: _onNewHost,
  onSaveHost,
  onCreateGroup,
}) => {
  const { t } = useI18n();
  const { generateKeyPair, execCommand } = useKeychainBackend();
  const [activeFilter, setActiveFilter] = useState<FilterTab>("key");
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useStoredViewMode(
    STORAGE_KEY_VAULT_KEYS_VIEW_MODE,
    "grid",
  );

  // Panel stack for navigation (supports back navigation)
  const [panelStack, setPanelStack] = useState<PanelMode[]>([]);
  const panel = useMemo(
    () =>
      panelStack.length > 0
        ? panelStack[panelStack.length - 1]
        : ({ type: "closed" } as PanelMode),
    [panelStack],
  );

  const panelTitle = useMemo(() => {
    switch (panel.type) {
      case "generate":
        return t("keychain.panel.generateKey");
      case "import":
        return t("keychain.panel.newKey");
      case "view":
        return t("keychain.panel.keyDetails");
      case "edit":
        return t("keychain.panel.editKey");
      case "identity":
        return panel.identity
          ? t("keychain.panel.editIdentity")
          : t("keychain.panel.newIdentity");
      case "export":
        return t("keychain.panel.keyExport");
      default:
        return "";
    }
  }, [panel, t]);

  const [showHostSelector, setShowHostSelector] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  // Export panel state
  const [exportLocation, setExportLocation] = useState(".ssh");
  const [exportFilename, setExportFilename] = useState("authorized_keys");
  const [exportHost, setExportHost] = useState<Host | null>(null);
  const [exportAdvancedOpen, setExportAdvancedOpen] = useState(false);
  const [exportScript, setExportScript] = useState(`DIR="$HOME/$1"
FILE="$DIR/$2"
if [ ! -d "$DIR" ]; then
  mkdir -p "$DIR"
  chmod 700 "$DIR"
fi
if [ ! -f "$FILE" ]; then
  touch "$FILE"
  chmod 600 "$FILE"
fi
echo $3 >> "$FILE"`);

  // Draft state for forms
  const [draftKey, setDraftKey] = useState<Partial<SSHKey>>({});
  const [draftIdentity, setDraftIdentity] = useState<Partial<Identity>>({});
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);

  const showError = useCallback((message: string, title = t("common.error")) => {
    toast.error(message, title);
  }, [t]);

  // Filter keys based on active tab and search
  const filteredKeys = useMemo(() => {
    let result = keys;

    // Filter by tab
    switch (activeFilter) {
      case "key":
        result = result.filter(
          (k) => k.source === "generated" || k.source === "imported",
        );
        break;
      case "certificate":
        result = result.filter(
          (k) => k.category === "certificate" || k.certificate,
        );
        break;
    }

    // Filter by search
    if (search.trim()) {
      const s = search.toLowerCase();
      result = result.filter(
        (k) =>
          k.label.toLowerCase().includes(s) ||
          k.type.toLowerCase().includes(s) ||
          k.publicKey?.toLowerCase().includes(s),
      );
    }

    return result;
  }, [keys, activeFilter, search]);

  // Filter identities based on search
  const filteredIdentities = useMemo(() => {
    if (!search.trim()) return identities;
    const s = search.toLowerCase();
    return identities.filter(
      (i) =>
        i.label.toLowerCase().includes(s) ||
        i.username.toLowerCase().includes(s),
    );
  }, [identities, search]);

  // Push a new panel onto the stack
  const pushPanel = useCallback((newPanel: PanelMode) => {
    setPanelStack((prev) => [...prev, newPanel]);
  }, []);

  // Pop the top panel from the stack (go back)
  const popPanel = useCallback(() => {
    setPanelStack((prev) => {
      if (prev.length <= 1) {
        // Last panel, close everything
        setDraftKey({});
        setDraftIdentity({});
        setShowPassphrase(false);
        setExportHost(null);
        setExportAdvancedOpen(false);
        return [];
      }
      return prev.slice(0, -1);
    });
  }, []);

  // Close all panels
  const closePanel = useCallback(() => {
    setPanelStack([]);
    setDraftKey({});
    setDraftIdentity({});
    setShowPassphrase(false);
    setExportHost(null);
    setExportAdvancedOpen(false);
  }, []);

  // Open panel for viewing key (replaces stack with single panel)
  const openKeyView = useCallback((key: SSHKey) => {
    setPanelStack([{ type: "view", key }]);
    setDraftKey({ ...key });
  }, []);

  // Open panel for exporting key (pushes onto stack)
  const openKeyExport = useCallback(
    (key: SSHKey) => {
      pushPanel({ type: "export", key });
      setExportHost(null);
      setExportLocation(".ssh");
      setExportFilename("authorized_keys");
    },
    [pushPanel],
  );

  // Open panel for editing key (replaces stack)
  const openKeyEdit = useCallback((key: SSHKey) => {
    setPanelStack([{ type: "edit", key }]);
    setDraftKey({ ...key });
  }, []);

  // Copy public key to clipboard
  const copyPublicKey = useCallback(async (key: SSHKey) => {
    if (key.publicKey) {
      try {
        await navigator.clipboard.writeText(key.publicKey);
        // Could add toast notification here
      } catch (err) {
        logger.error("Failed to copy public key:", err);
      }
    }
  }, []);

  // Open panel for new identity
  const openNewIdentity = useCallback(() => {
    setPanelStack([{ type: "identity" }]);
    setDraftIdentity({
      id: "",
      label: "",
      username: "",
      authMethod: "password",
      created: Date.now(),
    });
  }, []);

  // Open generate panel
  const openGenerate = useCallback(() => {
    const defaultType: KeyType = "ED25519";

    setPanelStack([{ type: "generate", keyType: "standard" }]);
    setDraftKey({
      id: "",
      label: "",
      type: defaultType,
      keySize: undefined,
      privateKey: "",
      publicKey: "",
      source: "generated",
      category: "key",
      created: Date.now(),
    });
  }, []);

  // Open import panel
  const openImport = useCallback(() => {
    setPanelStack([{ type: "import" }]);
    setDraftKey({
      id: "",
      label: "",
      type: "ED25519",
      privateKey: "",
      publicKey: "",
      source: "imported",
      category: "key",
      created: Date.now(),
    });
  }, []);

  // Handle standard key generation
  const handleGenerateStandard = useCallback(async () => {
    if (!draftKey.label?.trim()) {
      showError(t("keychain.validation.labelRequired"), t("common.validation"));
      return;
    }

    setIsGenerating(true);

    try {
      const keyType = (draftKey.type as KeyType) || "ED25519";
      const keySize = draftKey.keySize;

      // Use real key generation via Electron backend
      const result = await generateKeyPair({
        type: keyType,
        bits: keySize,
        comment: `${draftKey.label.trim()}@netcatty`,
      });
      if (!result) {
        throw new Error(
          t("keychain.error.generationUnavailable"),
        );
      }
      if (!result.success || !result.privateKey || !result.publicKey) {
        throw new Error(result.error || t("keychain.error.generateKeyPairFailed"));
      }

      const newKey: SSHKey = {
        id: crypto.randomUUID(),
        label: draftKey.label.trim(),
        type: keyType,
        keySize: keyType !== "ED25519" ? keySize : undefined,
        privateKey: result.privateKey,
        publicKey: result.publicKey,
        passphrase: draftKey.passphrase,
        savePassphrase: draftKey.savePassphrase,
        source: "generated",
        category: "key",
        created: Date.now(),
      };

      onSave(newKey);
      closePanel();
    } catch (err) {
      showError(
        err instanceof Error ? err.message : t("keychain.error.generateKeyFailed"),
        t("keychain.error.keyGenerationTitle"),
      );
    } finally {
      setIsGenerating(false);
    }
  }, [draftKey, onSave, closePanel, generateKeyPair, showError, t]);

  // Handle key import
  const handleImport = useCallback(() => {
    if (!draftKey.label?.trim() || !draftKey.privateKey?.trim()) {
      showError(t("keychain.validation.labelAndPrivateKeyRequired"), t("common.validation"));
      return;
    }

    // Detect key type from private key content
    let detectedType: KeyType = "ED25519";
    const pk = draftKey.privateKey.toLowerCase();
    if (pk.includes("rsa")) detectedType = "RSA";
    else if (pk.includes("ecdsa") || pk.includes("ec ")) detectedType = "ECDSA";
    else if (pk.includes("ed25519")) detectedType = "ED25519";

    const newKey: SSHKey = {
      id: crypto.randomUUID(),
      label: draftKey.label.trim(),
      type: (draftKey.type as KeyType) || detectedType,
      privateKey: draftKey.privateKey.trim(),
      publicKey: draftKey.publicKey?.trim() || undefined,
      certificate: draftKey.certificate?.trim() || undefined,
      passphrase: draftKey.passphrase,
      savePassphrase: draftKey.savePassphrase,
      source: "imported",
      category: draftKey.certificate ? "certificate" : "key",
      created: Date.now(),
    };

    onSave(newKey);
    closePanel();
  }, [draftKey, onSave, closePanel, showError, t]);

  // Handle save identity
  const handleSaveIdentity = useCallback(() => {
    if (!draftIdentity.label?.trim() || !draftIdentity.username?.trim()) {
      showError(t("keychain.validation.labelAndUsernameRequired"), t("common.validation"));
      return;
    }

    if (!onSaveIdentity) return;

    const newIdentity: Identity = {
      id: draftIdentity.id || crypto.randomUUID(),
      label: draftIdentity.label.trim(),
      username: draftIdentity.username.trim(),
      authMethod: draftIdentity.authMethod || "password",
      password: draftIdentity.password,
      keyId: draftIdentity.keyId,
      created: draftIdentity.created || Date.now(),
    };

    onSaveIdentity(newIdentity);
    closePanel();
  }, [draftIdentity, onSaveIdentity, closePanel, showError, t]);

  // Handle delete
  const handleDelete = useCallback(
    async (id: string) => {
      onDelete(id);
      if (panel.type === "view" && panel.key.id === id) {
        closePanel();
      }
    },
    [onDelete, panel, closePanel],
  );

  // Handle delete identity
  const _handleDeleteIdentity = useCallback(
    (id: string) => {
      onDeleteIdentity?.(id);
      if (panel.type === "identity" && panel.identity?.id === id) {
        closePanel();
      }
    },
    [onDeleteIdentity, panel, closePanel],
  );

  // Copy to clipboard
  const _copyToClipboard = useCallback((_text: string) => {
    navigator.clipboard.writeText(_text);
  }, []);

  // Get icon for key source
  const getKeyIcon = (key: SSHKey) => {
    if (key.certificate) return <BadgeCheck size={16} />;
    return <Key size={16} />;
  };

  // Get key type display
  const getKeyTypeDisplay = (key: SSHKey) => {
    return key.type;
  };

  // File input ref for import
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // Handle file import
  const handleFileImport = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (e) => {
        const content = e.target?.result as string;
        if (content) {
          // Try to detect key type from content
          let detectedType: KeyType = "ED25519";
          const lc = content.toLowerCase();
          if (lc.includes("rsa")) detectedType = "RSA";
          else if (lc.includes("ecdsa") || lc.includes("ec private"))
            detectedType = "ECDSA";
          else if (lc.includes("ed25519")) detectedType = "ED25519";

          // Extract label from filename (remove extension)
          const label = file.name.replace(/\.(pem|key|pub|ppk)$/i, "");

          setDraftKey((prev) => ({
            ...prev,
            privateKey: content,
            label: prev.label || label,
            type: detectedType,
          }));
        }
      };
      reader.readAsText(file);

      // Reset input so same file can be selected again
      event.target.value = "";
    },
    [],
  );

  // Handle drag and drop
  const _handleDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();

    const file = event.dataTransfer.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      if (content) {
        let detectedType: KeyType = "ED25519";
        const lc = content.toLowerCase();
        if (lc.includes("rsa")) detectedType = "RSA";
        else if (lc.includes("ecdsa") || lc.includes("ec private"))
          detectedType = "ECDSA";
        else if (lc.includes("ed25519")) detectedType = "ED25519";

        const label = file.name.replace(/\.(pem|key|pub|ppk)$/i, "");

        setDraftKey((prev) => ({
          ...prev,
          privateKey: content,
          label: prev.label || label,
          type: detectedType,
        }));
      }
    };
    reader.readAsText(file);
  }, []);

  const _handleDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
    },
    [],
  );

  return (
    <div className="h-full flex relative">
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".pem,.key,.pub,.ppk,*"
        className="hidden"
        onChange={handleFileImport}
      />

      {/* Main Content */}
      <div
        className={cn(
          "flex-1 overflow-y-auto transition-all duration-200",
          panel.type !== "closed" && "mr-[380px]",
        )}
      >
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-3 bg-secondary/60 border-b border-border/70 px-3 py-1.5">
          {/* Filter Tabs */}
          <div className="flex items-center gap-1">
            {/* KEY button with split interaction: left=switch view, right=dropdown */}
            <Dropdown>
              <div
                className={cn(
                  "flex items-center rounded-md transition-colors",
                  activeFilter === "key" ? "bg-primary/15" : "hover:bg-accent",
                )}
              >
                <Button
                  size="sm"
                  variant="ghost"
                  className={cn(
                    "h-8 px-3 gap-2 rounded-r-none hover:bg-transparent",
                    activeFilter === "key" && "text-primary",
                  )}
                  onClick={() => setActiveFilter("key")}
                >
                  <Key size={14} />
                  {t("keychain.filter.key")}
                </Button>
                <DropdownTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className={cn(
                      "h-8 px-1.5 rounded-l-none hover:bg-transparent",
                      activeFilter === "key" && "text-primary",
                    )}
                  >
                    <ChevronDown size={12} />
                  </Button>
                </DropdownTrigger>
              </div>
              <DropdownContent className="w-44" align="start" alignToParent>
                <Button
                  variant="ghost"
                  className="w-full justify-start gap-2"
                  onClick={openGenerate}
                >
                  <Plus size={14} /> {t("keychain.action.generateKey")}
                </Button>
                <Button
                  variant="ghost"
                  className="w-full justify-start gap-2"
                  onClick={openImport}
                >
                  <Upload size={14} /> {t("keychain.action.importKey")}
                </Button>
                {onSaveIdentity && (
                  <Button
                    variant="ghost"
                    className="w-full justify-start gap-2"
                    onClick={openNewIdentity}
                  >
                    <UserPlus size={14} /> {t("keychain.action.newIdentity")}
                  </Button>
                )}
              </DropdownContent>
            </Dropdown>

            {/* CERTIFICATE button with split interaction */}
            <Dropdown>
              <div
                className={cn(
                  "flex items-center rounded-md transition-colors",
                  activeFilter === "certificate"
                    ? "bg-primary/15"
                    : "hover:bg-accent",
                )}
              >
                <Button
                  size="sm"
                  variant="ghost"
                  className={cn(
                    "h-8 px-3 gap-2 rounded-r-none hover:bg-transparent",
                    activeFilter === "certificate" && "text-primary",
                  )}
                  onClick={() => setActiveFilter("certificate")}
                >
                  <BadgeCheck size={14} />
                  {t("keychain.filter.certificate")}
                  <span className="text-[10px] px-1.5 rounded-full bg-muted text-muted-foreground">
                    {keys.filter((k) => k.certificate).length}
                  </span>
                </Button>
                <DropdownTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className={cn(
                      "h-8 px-1.5 rounded-l-none hover:bg-transparent",
                      activeFilter === "certificate" && "text-primary",
                    )}
                  >
                    <ChevronDown size={12} />
                  </Button>
                </DropdownTrigger>
              </div>
              <DropdownContent className="w-44" align="start" alignToParent>
                <Button
                  variant="ghost"
                  className="w-full justify-start gap-2"
                  onClick={openImport}
                >
                  <Upload size={14} /> {t("keychain.action.importCertificate")}
                </Button>
              </DropdownContent>
            </Dropdown>
          </div>

          {/* Search and View Mode - hide search when panel is open */}
          <div className="ml-auto flex items-center gap-2 min-w-0 flex-shrink">
            {panel.type === "closed" && (
              <div className="relative flex-shrink min-w-[100px]">
                <Search
                  size={14}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t("common.searchPlaceholder")}
                  className="h-9 pl-8 w-full"
                />
              </div>
            )}
            <Dropdown>
              <DropdownTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 flex-shrink-0"
                >
                  {viewMode === "grid" ? (
                    <LayoutGrid size={16} />
                  ) : (
                    <ListIcon size={16} />
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
                  <LayoutGrid size={14} /> {t("keychain.view.grid")}
                </Button>
                <Button
                  variant={viewMode === "list" ? "secondary" : "ghost"}
                  className="w-full justify-start gap-2 h-9"
                  onClick={() => setViewMode("list")}
                >
                  <ListIcon size={14} /> {t("keychain.view.list")}
                </Button>
              </DropdownContent>
            </Dropdown>
          </div>
        </div>

        {/* Keys Section */}
        <div className="space-y-3 p-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-muted-foreground">
              {t("keychain.section.keys")}
            </h2>
            <span className="text-xs text-muted-foreground">
              {t("keychain.count.items", { count: filteredKeys.length })}
            </span>
          </div>

          {filteredKeys.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
              <div className="h-16 w-16 rounded-2xl bg-secondary/80 flex items-center justify-center mb-4">
                <Shield size={32} className="opacity-60" />
              </div>
              <h3 className="text-lg font-semibold text-foreground mb-2">
                {t("keychain.empty.title")}
              </h3>
              <p className="text-sm text-center max-w-sm mb-4">
                {t("keychain.empty.desc")}
              </p>
              {(activeFilter === "key" || activeFilter === "certificate") && (
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={openImport}>
                    <Upload size={14} className="mr-2" />
                    {t("common.import")}
                  </Button>
                  <Button onClick={openGenerate}>
                    <Plus size={14} className="mr-2" />
                    {t("common.generate")}
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div
              className={
                viewMode === "grid"
                  ? "grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
                  : "flex flex-col gap-0"
              }
            >
              {filteredKeys.map((key) => (
                <KeyCard
                  key={key.id}
                  keyItem={key}
                  viewMode={viewMode}
                  isSelected={
                    (panel.type === "view" && panel.key.id === key.id) ||
                    (panel.type === "export" && panel.key.id === key.id)
                  }
                  isMac={isMacOS()}
                  onClick={() => openKeyView(key)}
                  onEdit={() => openKeyEdit(key)}
                  onExport={() => openKeyExport(key)}
                  onCopyPublicKey={() => copyPublicKey(key)}
                  onDelete={() => handleDelete(key.id)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Identities Section */}
        {activeFilter === "key" && filteredIdentities.length > 0 && (
          <div className="space-y-3 px-3 pb-3">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-muted-foreground">
                {t("keychain.section.identities")}
              </h2>
              <span className="text-xs text-muted-foreground">
                {t("keychain.count.items", { count: filteredIdentities.length })}
              </span>
            </div>
            <div
              className={
                viewMode === "grid"
                  ? "grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
                  : "flex flex-col gap-0"
              }
            >
              {filteredIdentities.map((identity) => (
                <ContextMenu key={identity.id}>
                  <ContextMenuTrigger>
                    <IdentityCard
                      identity={identity}
                      viewMode={viewMode}
                      isSelected={
                        panel.type === "identity" &&
                        panel.identity?.id === identity.id
                      }
                      onClick={() => {
                        setPanelStack([{ type: "identity", identity }]);
                        setDraftIdentity({ ...identity });
                      }}
                    />
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem
                      onClick={() => {
                        setPanelStack([{ type: "identity", identity }]);
                        setDraftIdentity({ ...identity });
                      }}
                    >
                      <Edit2 className="mr-2 h-4 w-4" /> {t("action.edit")}
                    </ContextMenuItem>
                    {onDeleteIdentity && (
                      <>
                        <ContextMenuSeparator />
                        <ContextMenuItem
                          className="text-destructive"
                          onClick={() => {
                            const ok = window.confirm(
                              t("confirm.deleteIdentity", {
                                name: identity.label || "",
                              }),
                            );
                            if (!ok) return;
                            _handleDeleteIdentity(identity.id);
                          }}
                        >
                          <Trash2 className="mr-2 h-4 w-4" />{" "}
                          {t("action.delete")}
                        </ContextMenuItem>
                      </>
                    )}
                  </ContextMenuContent>
                </ContextMenu>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Slide-out Panel */}
      {panel.type !== "closed" && (
        <AsidePanel
          open={true}
          onClose={closePanel}
          title={panelTitle}
          showBackButton={panelStack.length > 1}
          onBack={popPanel}
          actions={
            panel.type === "identity" && panel.identity && onDeleteIdentity ? (
              <AsideActionMenu>
                <AsideActionMenuItem
                  variant="destructive"
                  icon={<Trash2 size={14} />}
                  onClick={() => {
                    const ok = window.confirm(
                      t("confirm.deleteIdentity", {
                        name: panel.identity?.label || "",
                      }),
                    );
                    if (!ok || !panel.identity) return;
                    _handleDeleteIdentity(panel.identity.id);
                  }}
                >
                  {t("common.delete")}
                </AsideActionMenuItem>
              </AsideActionMenu>
            ) : panel.type === "view" ? (
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <MoreHorizontal size={16} />
              </Button>
            ) : undefined
          }
        >
          <AsidePanelContent>
            {/* Generate Standard Key */}
            {panel.type === "generate" && panel.keyType === "standard" && (
              <GenerateStandardPanel
                draftKey={draftKey}
                setDraftKey={setDraftKey}
                showPassphrase={showPassphrase}
                setShowPassphrase={setShowPassphrase}
                isGenerating={isGenerating}
                onGenerate={handleGenerateStandard}
              />
            )}

            {/* Import Key */}
            {panel.type === "import" && (
              <ImportKeyPanel
                draftKey={draftKey}
                setDraftKey={setDraftKey}
                showPassphrase={showPassphrase}
                setShowPassphrase={setShowPassphrase}
                onImport={handleImport}
              />
            )}

            {/* View Key */}
            {panel.type === "view" && (
              <ViewKeyPanel
                keyItem={panel.key}
                onExport={() => openKeyExport(panel.key)}
              />
            )}

            {/* Identity Panel */}
            {panel.type === "identity" && (
              <IdentityPanel
                draftIdentity={draftIdentity}
                setDraftIdentity={setDraftIdentity}
                keys={keys}
                showPassphrase={showPassphrase}
                setShowPassphrase={setShowPassphrase}
                isNew={!panel.identity}
                onSave={handleSaveIdentity}
              />
            )}

            {/* Key Export Panel */}
            {panel.type === "export" && !showHostSelector && (
              <>
                {/* Key info card */}
                <div className="flex items-center gap-3 p-3 bg-card border border-border/80 rounded-lg">
                  <div
                    className={cn(
                      "h-10 w-10 rounded-md flex items-center justify-center",
                      panel.key.certificate
                        ? "bg-emerald-500/15 text-emerald-500"
                        : "bg-primary/15 text-primary",
                    )}
                  >
                    {getKeyIcon(panel.key)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold truncate">
                      {panel.key.label}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t("auth.keyType", { type: getKeyTypeDisplay(panel.key) })}
                    </p>
                  </div>
                </div>

                {/* Export to field */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-muted-foreground">
                      {t("keychain.export.exportTo")}
                    </Label>
                    <Button
                      variant="link"
                      className="h-auto p-0 text-primary text-sm"
                      onClick={() => setShowHostSelector(true)}
                    >
                      {t("keychain.export.selectHost")}
                    </Button>
                  </div>
                  <Input
                    value={exportHost?.label || ""}
                    readOnly
                    placeholder={t("common.selectAHostPlaceholder")}
                    className="bg-muted/50 cursor-pointer"
                    onClick={() => setShowHostSelector(true)}
                  />
                </div>

                {/* Location field */}
                <div className="space-y-2">
                  <Label className="text-muted-foreground">
                    {t("keychain.export.location")}
                  </Label>
                  <Input
                    value={exportLocation}
                    onChange={(e) => setExportLocation(e.target.value)}
                    placeholder=".ssh"
                  />
                </div>

                {/* Filename field */}
                <div className="space-y-2">
                  <Label className="text-muted-foreground">
                    {t("keychain.export.filename")}
                  </Label>
                  <Input
                    value={exportFilename}
                    onChange={(e) => setExportFilename(e.target.value)}
                    placeholder="authorized_keys"
                  />
                </div>

                {/* Info note */}
                <div className="flex items-start gap-2 p-3 bg-muted/50 border border-border/60 rounded-lg">
                  <Info
                    size={14}
                    className="mt-0.5 text-muted-foreground shrink-0"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("keychain.export.note", {
                      unix: "UNIX",
                      advanced: t("common.advanced"),
                    })}
                  </p>
                </div>

                {/* Advanced collapsible */}
                <Collapsible
                  open={exportAdvancedOpen}
                  onOpenChange={setExportAdvancedOpen}
                >
                  <CollapsibleTrigger asChild>
                    <Button
                      variant="ghost"
                      className="w-full justify-between px-0 h-10 hover:bg-transparent hover:text-current"
                    >
                      <span className="font-medium">{t("common.advanced")}</span>
                      <ChevronRight
                        size={16}
                        className={cn(
                          "transition-transform",
                          exportAdvancedOpen && "rotate-90",
                        )}
                      />
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="space-y-2 pt-2">
                    <Label className="text-muted-foreground">
                      {t("keychain.export.script")}
                    </Label>
                    <Textarea
                      value={exportScript}
                      onChange={(e) => setExportScript(e.target.value)}
                      className="min-h-[180px] font-mono text-xs"
                      placeholder={t("keychain.export.scriptPlaceholder")}
                    />
                  </CollapsibleContent>
                </Collapsible>

                {/* Export button */}
                <Button
                  className="w-full h-11"
                  disabled={
                    !exportHost ||
                    !exportLocation ||
                    !exportFilename ||
                    isExporting
                  }
                  onClick={async () => {
                    if (!exportHost || !panel.key.publicKey) return;

                    setIsExporting(true);

                    try {
                      const exportAuth = resolveHostAuth({
                        host: exportHost,
                        keys,
                        identities,
                      });

                      // Need either password or a usable key to run remote command.
                      if (!exportAuth.password && !exportAuth.key?.privateKey) {
                        throw new Error(
                          t("keychain.export.missingCredentials"),
                        );
                      }

                      const hostPrivateKey = exportAuth.key?.privateKey;

                      // Escape the public key for shell (single quotes, escape existing quotes)
                      const escapedPublicKey = panel.key.publicKey.replace(
                        /'/g,
                        "'\\''",
                      );

                      // Build the command by replacing $1, $2, $3
                      const scriptWithVars = exportScript
                        .replace(/\$1/g, exportLocation)
                        .replace(/\$2/g, exportFilename)
                        .replace(/\$3/g, `'${escapedPublicKey}'`);

                      // Execute the script directly - SSH exec handles multiline commands
                      const command = scriptWithVars;

                      // Execute via SSH
                      const result = await execCommand({
                        hostname: exportHost.hostname,
                        username: exportAuth.username,
                        port: exportHost.port || 22,
                        password: exportAuth.password,
                        privateKey: hostPrivateKey,
                        command,
                        timeout: 30000,
                      });

                      // Check result - code 0, null, or undefined with no stderr is success
                      const exitCode = result?.code;
                      const hasError = result?.stderr?.trim();
                      if (exitCode === 0 || (exitCode == null && !hasError)) {
                        // Update identity (preferred) or host to use this key for authentication
                        if (exportHost.identityId && onSaveIdentity) {
                          const existing = identities.find(
                            (i) => i.id === exportHost.identityId,
                          );
                          if (existing) {
                            onSaveIdentity({
                              ...existing,
                              authMethod: "key",
                              keyId: panel.key.id,
                            });
                          }
                        } else if (onSaveHost) {
                          onSaveHost({
                            ...exportHost,
                            identityFileId: panel.key.id,
                            authMethod: "key",
                          });
                        }
                        toast.success(
                          t("keychain.export.successMessage", {
                            host: exportHost.label,
                          }),
                          t("keychain.export.successTitle"),
                        );
                        closePanel();
                      } else {
                        const errorMsg =
                          hasError ||
                          result?.stdout?.trim() ||
                          t("keychain.export.exitCode", { code: exitCode });
                        toast.error(
                          t("keychain.export.failedMessage", { error: errorMsg }),
                          t("keychain.export.failedTitle"),
                        );
                      }
                    } catch (err) {
                      const message =
                        err instanceof Error ? err.message : String(err);
                      toast.error(
                        t("keychain.export.failedPrefix", { error: message }),
                        t("keychain.export.failedTitle"),
                      );
                    } finally {
                      setIsExporting(false);
                    }
                  }}
                >
                  {isExporting
                    ? t("keychain.export.exporting")
                    : t("keychain.export.exportAndAttach")}
                </Button>
              </>
            )}

            {/* Edit Key Panel */}
            {panel.type === "edit" && (
              <>
                <div className="space-y-2">
                  <Label>{t("keychain.edit.labelRequired")}</Label>
                  <Input
                    value={draftKey.label || ""}
                    onChange={(e) =>
                      setDraftKey({ ...draftKey, label: e.target.value })
                    }
                    placeholder={t("keychain.edit.keyLabelPlaceholder")}
                  />
                </div>

                <div className="space-y-2">
                  <Label className="text-destructive">
                    {t("keychain.edit.privateKeyRequired")}
                  </Label>
                  <Textarea
                    value={draftKey.privateKey || ""}
                    onChange={(e) =>
                      setDraftKey({ ...draftKey, privateKey: e.target.value })
                    }
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    className="min-h-[180px] font-mono text-xs"
                  />
                </div>

                <div className="space-y-2">
                  <Label className="text-muted-foreground">
                    {t("keychain.edit.publicKey")}
                  </Label>
                  <Textarea
                    value={draftKey.publicKey || ""}
                    onChange={(e) =>
                      setDraftKey({ ...draftKey, publicKey: e.target.value })
                    }
                    placeholder="ssh-ed25519 AAAA..."
                    className="min-h-[80px] font-mono text-xs"
                  />
                </div>

                <div className="space-y-2">
                  <Label className="text-muted-foreground">
                    {t("keychain.edit.certificate")}
                  </Label>
                  <Textarea
                    value={draftKey.certificate || ""}
                    onChange={(e) =>
                      setDraftKey({ ...draftKey, certificate: e.target.value })
                    }
                    placeholder={t("keychain.edit.certificatePlaceholder")}
                    className="min-h-[60px] font-mono text-xs"
                  />
                </div>

                {/* Key Export section */}
                <div className="pt-4 mt-4 border-t border-border/60">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-sm font-medium">
                      {t("keychain.edit.keyExport")}
                    </span>
                    <div className="h-4 w-4 rounded-full bg-muted flex items-center justify-center">
                      <Info size={10} className="text-muted-foreground" />
                    </div>
                  </div>
                  <Button
                    className="w-full h-11"
                    onClick={() => openKeyExport(panel.key)}
                  >
                    {t("keychain.edit.exportToHost")}
                  </Button>
                </div>

                {/* Save button */}
                <Button
                  className="w-full h-11 mt-4"
                  disabled={
                    !draftKey.label?.trim() || !draftKey.privateKey?.trim()
                  }
                  onClick={() => {
                    if (draftKey.id) {
                      onUpdate({
                        ...panel.key,
                        ...(draftKey as SSHKey),
                      });
                      closePanel();
                    }
                  }}
                >
                  {t("common.saveChanges")}
                </Button>
              </>
            )}
          </AsidePanelContent>

          {/* Host Selector Overlay for Export */}
          {showHostSelector && panel.type === "export" && (
            <SelectHostPanel
              hosts={hosts}
              customGroups={customGroups}
              selectedHostIds={exportHost?.id ? [exportHost.id] : []}
              multiSelect={false}
              onSelect={(host) => {
                setExportHost(host);
                setShowHostSelector(false);
              }}
              onBack={() => setShowHostSelector(false)}
              onContinue={() => setShowHostSelector(false)}
              availableKeys={keys}
              managedSources={managedSources}
              onSaveHost={onSaveHost}
              onCreateGroup={onCreateGroup}
            />
          )}
        </AsidePanel>
      )}
    </div>
  );
};

export default KeychainManager;
