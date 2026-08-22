import {
  BadgeCheck,
  ChevronDown,
  Copy,
  Edit2,
  ExternalLink,
  Key,
  LayoutGrid,
  List as ListIcon,
  Plus,
  Shield,
  Trash2,
  Upload,
  UserPlus,
} from "lucide-react";
import React, { useCallback, useMemo, useRef, useState } from "react";
import { useI18n } from "../application/i18n/I18nProvider";
import { useStoredViewMode } from "../application/state/useStoredViewMode";
import type { GroupConfig } from "../domain/models";
import { reorderVaultItems, sortByVaultOrder } from "../domain/vaultOrder";
import { STORAGE_KEY_VAULT_KEYS_VIEW_MODE } from "../infrastructure/config/storageKeys";
import { logger } from "../lib/logger";
import { cn } from "../lib/utils";
import { Host, Identity, KeyType, ProxyProfile, SSHKey } from "../types";
import { resolveImportedKeyType } from "./keychain/utils";
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
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./ui/context-menu";
import { Dropdown, DropdownContent, DropdownTrigger } from "./ui/dropdown";
import { toast } from "./ui/toast";
import { KeychainExportPanel } from "./KeychainExportPanel";
import { KeychainEditPanel } from "./KeychainEditPanel";
import {
  VaultHeaderSearch,
  VaultPageHeader,
  vaultHeaderIconButtonClass,
  vaultHeaderSecondaryButtonClass,
  vaultSectionTitleClass,
} from "./vault/VaultPageHeader";
import { VaultDeleteConfirmDialog } from "./vault/VaultDeleteConfirmDialog";
import { useVaultItemReorder } from "./vault/vaultReorderDrag";

// Import utilities and components from keychain module
import {
  GenerateStandardPanel,
  IdentityCard,
  IdentityPanel,
  ImportKeyPanel,
  isMacOS,
  KeyCard,
  type PanelMode,
  shouldShowIdentitySection,
  shouldShowKeySection,
  shouldShowSearchNoResults,
  ViewKeyPanel,
} from "./keychain";

interface KeychainManagerProps {
  keys: SSHKey[];
  identities?: Identity[];
  hosts?: Host[];
  proxyProfiles?: ProxyProfile[];
  customGroups?: string[];
  /**
   * Group default configurations. Needed by the "export public key to
   * host" flow so per-host SSH algorithm settings (legacy / skipEcdsa /
   * overrides) that the host inherits from its group are honored when
   * the export opens its one-off SSH connection.
   */
  groupConfigs?: GroupConfig[];
  managedSources?: ManagedSource[];
  onSave: (key: SSHKey) => void;
  onUpdate: (key: SSHKey) => void;
  onReorderKeys?: (keys: SSHKey[]) => void;
  onDelete: (id: string) => void;
  onSaveIdentity?: (identity: Identity) => void;
  onReorderIdentities?: (identities: Identity[]) => void;
  onDeleteIdentity?: (id: string) => void;
  onNewHost?: () => void;
  onSaveHost?: (host: Host) => void;
  onCreateGroup?: (groupPath: string) => void;
}

const KeychainManager: React.FC<KeychainManagerProps> = ({
  keys,
  identities = [],
  hosts = [],
  proxyProfiles = [],
  customGroups = [],
  groupConfigs = [],
  managedSources = [],
  onSave,
  onUpdate,
  onReorderKeys,
  onDelete,
  onSaveIdentity,
  onReorderIdentities,
  onDeleteIdentity,
  onNewHost: _onNewHost,
  onSaveHost,
  onCreateGroup,
}) => {
  const { t } = useI18n();
  const { generateKeyPair, execCommand } = useKeychainBackend();
  const [search, setSearch] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<{
    type: "key" | "identity";
    id: string;
    name: string;
  } | null>(null);
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
  const listRef = useRef<HTMLDivElement | null>(null);

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

  const keyReorder = useVaultItemReorder({
    containerRef: listRef,
    viewMode,
    dragType: "key-id",
    targetAttribute: "data-key-id",
    disabled: !onReorderKeys || search.trim().length > 0,
    onReorder: (sourceId, targetId, position) => {
      onReorderKeys?.(reorderVaultItems(keys, sourceId, targetId, position));
    },
  });
  const identityReorder = useVaultItemReorder({
    containerRef: listRef,
    viewMode,
    dragType: "identity-id",
    targetAttribute: "data-identity-id",
    disabled: !onReorderIdentities || search.trim().length > 0,
    onReorder: (sourceId, targetId, position) => {
      onReorderIdentities?.(reorderVaultItems(identities, sourceId, targetId, position));
    },
  });

  const showError = useCallback((message: string, title = t("common.error")) => {
    toast.error(message, title);
  }, [t]);

  // Ordered key collection (keys and certificates on one page)
  const orderedKeys = useMemo(() => sortByVaultOrder(keys), [keys]);

  // Filter keys by search
  const filteredKeys = useMemo(() => {
    if (!search.trim()) return orderedKeys;
    const s = search.toLowerCase();
    return orderedKeys.filter(
      (k) =>
        k.label.toLowerCase().includes(s) ||
        k.type.toLowerCase().includes(s) ||
        k.publicKey?.toLowerCase().includes(s),
    );
  }, [orderedKeys, search]);

  // Filter identities based on search
  const filteredIdentities = useMemo(() => {
    if (!search.trim()) return sortByVaultOrder(identities);
    const s = search.toLowerCase();
    return sortByVaultOrder(identities.filter(
      (i) =>
        i.label.toLowerCase().includes(s) ||
        i.username.toLowerCase().includes(s),
    ));
  }, [identities, search]);

  const showIdentitySection = shouldShowIdentitySection({
    identityCount: identities.length,
    filteredIdentityCount: filteredIdentities.length,
    filteredKeyCount: filteredKeys.length,
    search,
  });
  const showKeySection = shouldShowKeySection({
    identityCount: identities.length,
    filteredKeyCount: filteredKeys.length,
    search,
  });

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
        resident: keyType === "ED25519-SK" || keyType === "ECDSA-SK"
          ? !!(draftKey as { resident?: boolean }).resident
          : undefined,
        verifyRequired: keyType === "ED25519-SK" || keyType === "ECDSA-SK"
          ? !!(draftKey as { verifyRequired?: boolean }).verifyRequired
          : undefined,
      });
      if (!result) {
        throw new Error(
          t("keychain.error.generationUnavailable"),
        );
      }
      if (!result.success || !result.privateKey || !result.publicKey) {
        throw new Error(result.error || t("keychain.error.generateKeyPairFailed"));
      }

      const resolvedType = (result.keyType as KeyType | undefined) || keyType;
      const isFidoSk = resolvedType === "ED25519-SK" || resolvedType === "ECDSA-SK";
      const newKey: SSHKey = {
        id: crypto.randomUUID(),
        label: draftKey.label.trim(),
        type: resolvedType,
        keySize: resolvedType === "ED25519" || isFidoSk ? undefined : keySize,
        privateKey: result.privateKey,
        publicKey: result.publicKey,
        passphrase: isFidoSk ? undefined : draftKey.passphrase,
        savePassphrase: isFidoSk ? undefined : draftKey.savePassphrase,
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

    // Prefer material detection over the form's seeded type (openImport always
    // seeds type: "ED25519", which would discard SK detection if used first).
    const detectedType = resolveImportedKeyType({
      privateKey: draftKey.privateKey,
      publicKey: draftKey.publicKey,
    });

    const newKey: SSHKey = {
      id: crypto.randomUUID(),
      label: draftKey.label.trim(),
      type: detectedType,
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
    (id: string) => {
      const key = keys.find((item) => item.id === id);
      setDeleteTarget({
        type: "key",
        id,
        name: key?.label || t("keychain.panel.keyDetails"),
      });
    },
    [keys, t],
  );

  // Handle delete identity
  const _handleDeleteIdentity = useCallback(
    (id: string) => {
      const identity = identities.find((item) => item.id === id);
      setDeleteTarget({
        type: "identity",
        id,
        name: identity?.label || t("keychain.panel.editIdentity"),
      });
    },
    [identities, t],
  );

  const confirmDeleteTarget = useCallback(
    () => {
      if (!deleteTarget) return;

      if (deleteTarget.type === "key") {
        onDelete(deleteTarget.id);
        if (panel.type === "view" && panel.key.id === deleteTarget.id) {
          closePanel();
        }
      } else {
        onDeleteIdentity?.(deleteTarget.id);
        if (panel.type === "identity" && panel.identity?.id === deleteTarget.id) {
          closePanel();
        }
      }

      setDeleteTarget(null);
    },
    [closePanel, deleteTarget, onDelete, onDeleteIdentity, panel],
  );

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
          const detectedType = resolveImportedKeyType({
            privateKey: content.includes("PRIVATE KEY") ? content : content,
            publicKey: content.includes("PRIVATE KEY") ? undefined : content,
          });

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

  return (
    <div className="h-full min-w-0 w-full overflow-hidden flex relative">
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
          "flex-1 min-w-0 flex flex-col min-h-0 transition-all duration-200",
          panel.type !== "closed" && "mr-[380px]",
        )}
      >
        <VaultPageHeader>
          {/* Action buttons: New Key (split) | Import Certificate | New Identity */}
          <div className="flex items-center gap-1">
            {/* New Key split button — same secondary style as sibling header actions */}
            <Dropdown>
              <div className="flex items-center rounded-md shrink-0 bg-foreground/5 text-foreground">
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-10 px-3 gap-2 rounded-r-none bg-transparent hover:bg-foreground/10 shadow-none border-0"
                  onClick={openImport}
                >
                  <Plus size={14} />
                  {t("keychain.panel.newKey")}
                </Button>
                <DropdownTrigger asChild>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-10 px-2 rounded-l-none bg-transparent hover:bg-foreground/10 shadow-none border-0"
                  >
                    <ChevronDown size={14} />
                  </Button>
                </DropdownTrigger>
              </div>
              <DropdownContent className="w-44" align="start" alignToParent>
                <Button
                  variant="ghost"
                  className="w-full justify-start gap-2"
                  onClick={openGenerate}
                >
                  <Key size={14} /> {t("keychain.action.generateKey")}
                </Button>
              </DropdownContent>
            </Dropdown>

            {/* Import Certificate - single action button */}
            <Button
              size="sm"
              variant="secondary"
              className={cn(vaultHeaderSecondaryButtonClass, "shrink-0")}
              onClick={openImport}
            >
              <BadgeCheck size={14} />
              {t("keychain.action.importCertificate")}
            </Button>

            {onSaveIdentity && (
              <Button
                size="sm"
                variant="secondary"
                className={cn(vaultHeaderSecondaryButtonClass, "shrink-0")}
                onClick={openNewIdentity}
              >
                <UserPlus size={14} />
                {t("keychain.action.newIdentity")}
              </Button>
            )}
          </div>

          {/* Search and View Mode - hide search when panel is open */}
          <div className="ml-auto flex items-center gap-2 min-w-0 flex-shrink">
            {panel.type === "closed" && (
              <VaultHeaderSearch
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("common.searchPlaceholder")}
                className="flex-shrink w-64"
              />
            )}
            <Dropdown>
              <DropdownTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(vaultHeaderIconButtonClass, "flex-shrink-0")}
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
        </VaultPageHeader>

        {/* Scrollable Content */}
        <div
          ref={listRef}
          className="flex-1 min-w-0 w-full overflow-y-auto"
          onDragOverCapture={(event) => {
            keyReorder.handleDragOverCapture(event);
            identityReorder.handleDragOverCapture(event);
          }}
          onDragOver={(event) => {
            keyReorder.handleDragOver(event);
            identityReorder.handleDragOver(event);
          }}
          onDropCapture={(event) => {
            keyReorder.handleDropCapture(event);
            identityReorder.handleDropCapture(event);
          }}
          onDragEndCapture={() => {
            keyReorder.handleDragEndCapture();
            identityReorder.handleDragEndCapture();
          }}
        >
          {/* Keys Section */}
          {showKeySection && (
            <div
              className="min-w-0 w-full space-y-3 p-3"
              data-section="keychain-keys"
            >
              <div className="flex items-center justify-between">
                <h2 className={vaultSectionTitleClass}>
                  {t("keychain.section.keys")}
                </h2>
                <span className="text-xs text-muted-foreground">
                  {t("keychain.count.items", { count: filteredKeys.length })}
                </span>
              </div>

              {orderedKeys.length === 0 ? (
                <div
                  className="flex flex-col items-center justify-center h-64 text-muted-foreground"
                  data-section="keychain-empty"
                >
                  <div className="h-16 w-16 rounded-2xl bg-secondary/80 flex items-center justify-center mb-4">
                    <Shield size={32} className="opacity-60" />
                  </div>
                  <h3 className="text-lg font-semibold text-foreground mb-2">
                    {t("keychain.empty.title")}
                  </h3>
                  <p className="text-sm text-center max-w-sm mb-4">
                    {t("keychain.empty.desc")}
                  </p>
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
                </div>
              ) : shouldShowSearchNoResults(
                search,
                filteredKeys.length,
                orderedKeys.length,
              ) ? (
                <div
                  className="flex h-40 items-center justify-center text-sm text-muted-foreground"
                  data-section="keychain-no-results"
                >
                  {t("common.noResultsFound")}
                </div>
              ) : (
                <div
                  className={
                    viewMode === "grid"
                      ? "grid min-w-0 w-full max-w-full gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
                      : "flex min-w-0 w-full max-w-full flex-col gap-0"
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
                      reorderProps={keyReorder.getItemReorderProps(key.id, `key:${key.id}`)}
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
          )}

          {/* Identities Section */}
          {showIdentitySection && (
            <div
              className="min-w-0 w-full space-y-3 p-3"
              data-section="keychain-identities"
            >
              <div className="flex items-center justify-between">
                <h2 className={vaultSectionTitleClass}>
                  {t("keychain.section.identities")}
                </h2>
                <span className="text-xs text-muted-foreground">
                  {t("keychain.count.items", { count: filteredIdentities.length })}
                </span>
              </div>
              {shouldShowSearchNoResults(
                search,
                filteredIdentities.length,
                identities.length,
              ) ? (
                <div
                  className="flex h-40 items-center justify-center text-sm text-muted-foreground"
                  data-section="keychain-no-results"
                >
                  {t("common.noResultsFound")}
                </div>
              ) : (
                <div
                  className={
                    viewMode === "grid"
                      ? "grid min-w-0 w-full max-w-full gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
                      : "flex min-w-0 w-full max-w-full flex-col gap-0"
                  }
                >
                  {filteredIdentities.map((identity) => (
                  <ContextMenu key={identity.id}>
                    <ContextMenuTrigger className="block min-w-0 w-full max-w-full">
                      <IdentityCard
                        identity={identity}
                        viewMode={viewMode}
                        isSelected={
                          panel.type === "identity" &&
                          panel.identity?.id === identity.id
                        }
                        reorderProps={identityReorder.getItemReorderProps(identity.id, `identity:${identity.id}`)}
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
                            onClick={() => _handleDeleteIdentity(identity.id)}
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
              )}
            </div>
          )}
        </div>
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
                    if (panel.identity) _handleDeleteIdentity(panel.identity.id);
                  }}
                >
                  {t("common.delete")}
                </AsideActionMenuItem>
              </AsideActionMenu>
            ) : panel.type === "view" ? (
              <AsideActionMenu>
                {panel.key.publicKey ? (
                  <AsideActionMenuItem
                    icon={<Copy size={14} />}
                    onClick={() => copyPublicKey(panel.key)}
                  >
                    {t("action.copyPublicKey")}
                  </AsideActionMenuItem>
                ) : null}
                <AsideActionMenuItem
                  icon={<ExternalLink size={14} />}
                  onClick={() => openKeyExport(panel.key)}
                >
                  {t("action.keyExport")}
                </AsideActionMenuItem>
                <AsideActionMenuItem
                  icon={<Edit2 size={14} />}
                  onClick={() => openKeyEdit(panel.key)}
                >
                  {t("action.edit")}
                </AsideActionMenuItem>
                <AsideActionMenuItem
                  variant="destructive"
                  icon={<Trash2 size={14} />}
                  onClick={() => handleDelete(panel.key.id)}
                >
                  {t("action.delete")}
                </AsideActionMenuItem>
              </AsideActionMenu>
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

            {panel.type === "export" && !showHostSelector && (
              <KeychainExportPanel
                panel={panel}
                t={t}
                getKeyIcon={getKeyIcon}
                getKeyTypeDisplay={getKeyTypeDisplay}
                setShowHostSelector={setShowHostSelector}
                exportHost={exportHost}
                exportLocation={exportLocation}
                setExportLocation={setExportLocation}
                exportFilename={exportFilename}
                setExportFilename={setExportFilename}
                exportAdvancedOpen={exportAdvancedOpen}
                setExportAdvancedOpen={setExportAdvancedOpen}
                exportScript={exportScript}
                setExportScript={setExportScript}
                isExporting={isExporting}
                setIsExporting={setIsExporting}
                keys={keys}
                identities={identities}
                groupConfigs={groupConfigs}
                execCommand={execCommand}
                onSaveIdentity={onSaveIdentity}
                onSaveHost={onSaveHost}
                closePanel={closePanel}
              />
            )}

            {panel.type === "edit" && (
              <KeychainEditPanel
                panel={panel}
                t={t}
                draftKey={draftKey}
                setDraftKey={setDraftKey}
                showPassphrase={showPassphrase}
                setShowPassphrase={setShowPassphrase}
                openKeyExport={openKeyExport}
                onUpdate={onUpdate}
                closePanel={closePanel}
              />
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
              proxyProfiles={proxyProfiles}
              managedSources={managedSources}
              onSaveHost={onSaveHost}
              onCreateGroup={onCreateGroup}
            />
          )}
        </AsidePanel>
      )}

      <VaultDeleteConfirmDialog
        open={Boolean(deleteTarget)}
        title={t("vault.deleteConfirm.title", {
          name: deleteTarget?.name ?? "",
        })}
        description={t("vault.deleteConfirm.desc")}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        onConfirm={confirmDeleteTarget}
      />
    </div>
  );
};

export default KeychainManager;
