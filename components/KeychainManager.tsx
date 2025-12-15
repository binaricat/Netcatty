import {
  BadgeCheck,
  ChevronDown,
  ChevronRight,
  Fingerprint,
  Info,
  Key,
  LayoutGrid,
  List as ListIcon,
  MoreHorizontal,
  Plus,
  Search,
  Shield,
  Upload,
  UserPlus,
} from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";
import { logger } from "../lib/logger";
import { cn } from "../lib/utils";
import { Host, Identity, KeyType, SSHKey } from "../types";
import { useKeychainBackend } from "../application/state/useKeychainBackend";
import { useWebAuthnBackend } from "../application/state/useWebAuthnBackend";
import SelectHostPanel from "./SelectHostPanel";
import { AsidePanel, AsidePanelContent } from "./ui/aside-panel";
import { Button } from "./ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";
import { Dropdown, DropdownContent, DropdownTrigger } from "./ui/dropdown";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { toast } from "./ui/toast";

// Import utilities and components from keychain module
import {
  createBiometricCredential,
  createFido2Credential,
  type FilterTab,
  GenerateBiometricPanel,
  GenerateFido2Panel,
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
  onSave,
  onUpdate,
  onDelete,
  onSaveIdentity,
  onDeleteIdentity,
  onNewHost: _onNewHost,
  onSaveHost,
  onCreateGroup,
}) => {
  const { generateKeyPair, execCommand } = useKeychainBackend();
  const { hasBrowserWebAuthn: _hasBrowserWebAuthn, createCredentialInBrowser } = useWebAuthnBackend();
  const [activeFilter, setActiveFilter] = useState<FilterTab>("key");
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");

  // Panel stack for navigation (supports back navigation)
  const [panelStack, setPanelStack] = useState<PanelMode[]>([]);
  const panel = useMemo(
    () =>
      panelStack.length > 0
        ? panelStack[panelStack.length - 1]
        : ({ type: "closed" } as PanelMode),
    [panelStack],
  );

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

  // Detect if running on macOS
  const isMac = useMemo(() => {
    return (
      navigator.platform.toLowerCase().includes("mac") ||
      navigator.userAgent.toLowerCase().includes("mac")
    );
  }, []);

  // Biometric authentication label based on platform
  const biometricLabel = isMac ? "TOUCH ID" : "WINDOWS HELLO";

  // Draft state for forms
  const [draftKey, setDraftKey] = useState<Partial<SSHKey>>({});
  const [draftIdentity, setDraftIdentity] = useState<Partial<Identity>>({});
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);

  const showError = useCallback((message: string, title = "Error") => {
    toast.error(message, title);
  }, []);

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
      case "biometric":
        result = result.filter((k) => k.source === "biometric");
        break;
      case "fido2":
        result = result.filter((k) => k.source === "fido2");
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
  const openGenerate = useCallback(
    (keyType: "standard" | "biometric" | "fido2") => {
      const defaultType =
        keyType === "biometric" || keyType === "fido2" ? "ECDSA" : "ED25519";
      // Set default keySize based on type: ED25519 doesn't need size, RSA defaults to 4096, ECDSA to 256
      const getDefaultKeySize = (type: string) => {
        if (type === "ED25519") return undefined;
        if (type === "RSA") return 4096;
        return 256; // ECDSA
      };

      const getSource = () => {
        if (keyType === "biometric") return "biometric";
        if (keyType === "fido2") return "fido2";
        return "generated";
      };

      setPanelStack([{ type: "generate", keyType }]);
      setDraftKey({
        id: "",
        label: "",
        type: defaultType,
        keySize: getDefaultKeySize(defaultType),
        privateKey: "",
        publicKey: "",
        source: getSource(),
        category: "key",
        created: Date.now(),
      });
    },
    [],
  );

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
      showError("Please enter a label for the key", "Validation");
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
          "Key generation not available - please ensure the app is running in Electron",
        );
      }
      if (!result.success || !result.privateKey || !result.publicKey) {
        throw new Error(result.error || "Failed to generate key pair");
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
      showError(err instanceof Error ? err.message : "Failed to generate key", "Key Generation");
    } finally {
      setIsGenerating(false);
    }
  }, [draftKey, onSave, closePanel, generateKeyPair, showError]);

  // Handle biometric key generation (Windows Hello / Touch ID)
  // Uses IPC to create credential via a localhost popup window for WebAuthn security
  const handleGenerateBiometric = useCallback(async () => {
    if (!draftKey.label?.trim()) {
      showError("Please enter a label for the key", "Validation");
      return;
    }

    setIsGenerating(true);

    try {
      // Use WebAuthn (macOS may use a browser fallback to reliably show Touch ID prompt)
       const result = await createBiometricCredential(
         draftKey.label.trim(),
         createCredentialInBrowser,
         // Callback when browser fallback is triggered
         () => {
           toast.info(
            `A browser window will open to complete ${isMac ? "Touch ID" : "Windows Hello"}. Finish the prompt there, then return to Netcatty.`,
            isMac ? "Touch ID" : "Windows Hello",
            );
          },
        );

      if (!result) {
        throw new Error("Credential creation was cancelled");
      }

      const newKey: SSHKey = {
        id: crypto.randomUUID(),
        label: draftKey.label.trim(),
        type: "ECDSA",
        privateKey: "", // Biometric keys don't have exportable private keys
        publicKey: result.publicKey,
        credentialId: result.credentialId,
        rpId: result.rpId,
        source: "biometric",
        category: "key",
        created: Date.now(),
      };

      onSave(newKey);
      closePanel();
    } catch (err) {
      showError(
        err instanceof Error
          ? err.message
          : "Failed to create biometric credential",
        "Biometric Setup",
      );
    } finally {
      setIsGenerating(false);
    }
  }, [
    draftKey,
    createCredentialInBrowser,
    onSave,
    closePanel,
    showError,
  ]);

  // Handle FIDO2 hardware key registration
  const handleGenerateFido2 = useCallback(async () => {
    if (!draftKey.label?.trim()) {
      showError("Please enter a label for the security key", "Validation");
      return;
    }

    setIsGenerating(true);

    try {
      const result = await createFido2Credential(draftKey.label.trim());

      if (!result) {
        throw new Error("Security key registration was cancelled");
      }

      const newKey: SSHKey = {
        id: crypto.randomUUID(),
        label: draftKey.label.trim(),
        type: "ECDSA",
        privateKey: "", // Hardware keys don't expose private keys
        publicKey: result.publicKey,
        credentialId: result.credentialId,
        rpId: result.rpId,
        source: "fido2",
        category: "key",
        created: Date.now(),
      };

      onSave(newKey);
      closePanel();
    } catch (err) {
      showError(
        err instanceof Error ? err.message : "Failed to register security key",
        "FIDO2 Setup",
      );
    } finally {
      setIsGenerating(false);
    }
  }, [draftKey, onSave, closePanel, showError]);

  // Handle key import
  const handleImport = useCallback(() => {
    if (!draftKey.label?.trim() || !draftKey.privateKey?.trim()) {
      showError("Label and private key are required", "Validation");
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
  }, [draftKey, onSave, closePanel, showError]);

  // Handle save identity
  const handleSaveIdentity = useCallback(() => {
    if (!draftIdentity.label?.trim() || !draftIdentity.username?.trim()) {
      showError("Label and username are required", "Validation");
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
  }, [draftIdentity, onSaveIdentity, closePanel, showError]);

  // Handle delete
  const handleDelete = useCallback(
    (id: string) => {
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
    if (key.source === "biometric") return <Fingerprint size={16} />;
    if (key.source === "fido2") return <Shield size={16} />;
    if (key.certificate) return <BadgeCheck size={16} />;
    return <Key size={16} />;
  };

  // Get key type display
  const getKeyTypeDisplay = (key: SSHKey) => {
    if (key.source === "biometric") return isMac ? "Touch ID" : "Windows Hello";
    if (key.source === "fido2") return "FIDO2";
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
                  KEY
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
                  onClick={() => openGenerate("standard")}
                >
                  <Plus size={14} /> Generate Key
                </Button>
                <Button
                  variant="ghost"
                  className="w-full justify-start gap-2"
                  onClick={openImport}
                >
                  <Upload size={14} /> Import Key
                </Button>
                {onSaveIdentity && (
                  <Button
                    variant="ghost"
                    className="w-full justify-start gap-2"
                    onClick={openNewIdentity}
                  >
                    <UserPlus size={14} /> New Identity
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
                  CERTIFICATE
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
                  <Upload size={14} /> Import Certificate
                </Button>
              </DropdownContent>
            </Dropdown>

            <Button
              size="sm"
              variant={activeFilter === "biometric" ? "secondary" : "ghost"}
              className={cn(
                "h-8 px-3 gap-2",
                activeFilter === "biometric" && "bg-primary/15 text-primary",
              )}
              onClick={() => setActiveFilter("biometric")}
            >
              <Fingerprint size={14} />
              {biometricLabel}
            </Button>

            <Button
              size="sm"
              variant={activeFilter === "fido2" ? "secondary" : "ghost"}
              className={cn(
                "h-8 px-3 gap-2",
                activeFilter === "fido2" && "bg-primary/15 text-primary",
              )}
              onClick={() => setActiveFilter("fido2")}
            >
              <Shield size={14} />
              FIDO2
            </Button>
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
                  placeholder="Search..."
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
                  <LayoutGrid size={14} /> Grid
                </Button>
                <Button
                  variant={viewMode === "list" ? "secondary" : "ghost"}
                  className="w-full justify-start gap-2 h-9"
                  onClick={() => setViewMode("list")}
                >
                  <ListIcon size={14} /> List
                </Button>
              </DropdownContent>
            </Dropdown>
          </div>
        </div>

        {/* Keys Section */}
        <div className="space-y-3 p-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-muted-foreground">
              Keys
            </h2>
            <span className="text-xs text-muted-foreground">
              {filteredKeys.length} items
            </span>
          </div>

          {filteredKeys.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
              <div className="h-16 w-16 rounded-2xl bg-secondary/80 flex items-center justify-center mb-4">
                <Shield size={32} className="opacity-60" />
              </div>
              <h3 className="text-lg font-semibold text-foreground mb-2">
                {activeFilter === "biometric"
                  ? `Set up ${isMac ? "Touch ID" : "Windows Hello"}`
                  : activeFilter === "fido2"
                    ? "Add a security key"
                    : "Set up your keys"}
              </h3>
              <p className="text-sm text-center max-w-sm mb-4">
                {activeFilter === "biometric"
                  ? `Create biometric SSH keys secured by ${isMac ? "Touch ID" : "Windows Hello"} for passwordless authentication.`
                  : activeFilter === "fido2"
                    ? "Connect a hardware security key (YubiKey, etc.) for enhanced security."
                    : "Import or generate SSH keys for secure authentication."}
              </p>
              {activeFilter === "biometric" && (
                <Button onClick={() => openGenerate("biometric")}>
                  <Fingerprint size={14} className="mr-2" />
                  Create Biometric Key
                </Button>
              )}
              {activeFilter === "fido2" && (
                <Button onClick={() => openGenerate("fido2")}>
                  <Shield size={14} className="mr-2" />
                  Register Security Key
                </Button>
              )}
              {(activeFilter === "key" || activeFilter === "certificate") && (
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={openImport}>
                    <Upload size={14} className="mr-2" />
                    Import
                  </Button>
                  <Button onClick={() => openGenerate("standard")}>
                    <Plus size={14} className="mr-2" />
                    Generate
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
                Identities
              </h2>
              <span className="text-xs text-muted-foreground">
                {filteredIdentities.length} items
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
                <IdentityCard
                  key={identity.id}
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
          title={
            panel.type === "generate" && panel.keyType === "biometric"
              ? "Generate Biometric Key"
              : panel.type === "generate" && panel.keyType === "standard"
                ? "Generate Key"
                : panel.type === "generate" && panel.keyType === "fido2"
                  ? "Register Security Key"
                  : panel.type === "import"
                    ? "New Key"
                    : panel.type === "view"
                      ? panel.key.source === "biometric"
                        ? "Biometric Key"
                        : panel.key.source === "fido2"
                          ? "Security Key"
                          : "Key Details"
                      : panel.type === "edit"
                        ? "Edit Key"
                        : panel.type === "identity"
                          ? panel.identity
                            ? "Edit Identity"
                            : "New Identity"
                          : panel.type === "export"
                            ? "Key Export"
                            : ""
          }
          showBackButton={panelStack.length > 1}
          onBack={popPanel}
          actions={
            panel.type === "view" || panel.type === "identity" ? (
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <MoreHorizontal size={16} />
              </Button>
            ) : undefined
          }
        >
          <AsidePanelContent>
            {/* Generate Biometric Key */}
            {panel.type === "generate" && panel.keyType === "biometric" && (
              <GenerateBiometricPanel
                draftKey={draftKey}
                setDraftKey={setDraftKey}
                isGenerating={isGenerating}
                onGenerate={handleGenerateBiometric}
              />
            )}

            {/* Register FIDO2 Hardware Key */}
            {panel.type === "generate" && panel.keyType === "fido2" && (
              <GenerateFido2Panel
                draftKey={draftKey}
                setDraftKey={setDraftKey}
                isGenerating={isGenerating}
                onGenerate={handleGenerateFido2}
              />
            )}

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
                      panel.key.source === "biometric"
                        ? "bg-blue-500/15 text-blue-500"
                        : panel.key.source === "fido2"
                          ? "bg-amber-500/15 text-amber-500"
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
                      Type {getKeyTypeDisplay(panel.key)}
                    </p>
                  </div>
                </div>

                {/* Export to field */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-muted-foreground">Export to *</Label>
                    <Button
                      variant="link"
                      className="h-auto p-0 text-primary text-sm"
                      onClick={() => setShowHostSelector(true)}
                    >
                      Select Host
                    </Button>
                  </div>
                  <Input
                    value={exportHost?.label || ""}
                    readOnly
                    placeholder="Select a host..."
                    className="bg-muted/50 cursor-pointer"
                    onClick={() => setShowHostSelector(true)}
                  />
                </div>

                {/* Location field */}
                <div className="space-y-2">
                  <Label className="text-muted-foreground">
                    Location ~ $1 *
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
                    Filename ~ $2 *
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
                    Key export currently supports only{" "}
                    <span className="font-semibold text-foreground">UNIX</span>{" "}
                    systems. Use{" "}
                    <span className="font-semibold text-foreground">
                      Advanced
                    </span>{" "}
                    section to customize the export script.
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
                      <span className="font-medium">Advanced</span>
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
                    <Label className="text-muted-foreground">Script *</Label>
                    <Textarea
                      value={exportScript}
                      onChange={(e) => setExportScript(e.target.value)}
                      className="min-h-[180px] font-mono text-xs"
                      placeholder="Export script..."
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
                      // Check for authentication method - prefer password for key export
                      // Since we're exporting a key to a host, we need password auth
                      if (!exportHost.password && !exportHost.identityFileId) {
                        throw new Error(
                          "Host has no saved password or key. Please add password credentials to the host first.",
                        );
                      }

                      // Get private key for authentication if host uses key auth
                      const hostPrivateKey = exportHost.identityFileId
                        ? keys.find((k) => k.id === exportHost.identityFileId)
                          ?.privateKey
                        : undefined;

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
                        username: exportHost.username,
                        port: exportHost.port || 22,
                        password: exportHost.password,
                        privateKey: hostPrivateKey,
                        command,
                        timeout: 30000,
                      });

                      // Check result - code 0, null, or undefined with no stderr is success
                      const exitCode = result?.code;
                      const hasError = result?.stderr?.trim();
                      if (exitCode === 0 || (exitCode == null && !hasError)) {
                        // Update host to use this key for authentication
                        if (onSaveHost) {
                          const updatedHost: Host = {
                            ...exportHost,
                            identityFileId: panel.key.id,
                            authMethod: "key",
                          };
                          onSaveHost(updatedHost);
                        }
                        toast.success(
                          `Public key exported and attached to ${exportHost.label}`,
                          "Export Successful",
                        );
                        closePanel();
                      } else {
                        const errorMsg =
                          hasError ||
                          result?.stdout?.trim() ||
                          `Command exited with code ${exitCode}`;
                        toast.error(
                          `Failed to export key: ${errorMsg}`,
                          "Export Failed",
                        );
                      }
                    } catch (err) {
                      const message =
                        err instanceof Error ? err.message : String(err);
                      toast.error(`Export failed: ${message}`, "Export Failed");
                    } finally {
                      setIsExporting(false);
                    }
                  }}
                >
                  {isExporting ? "Exporting..." : "Export and Attach"}
                </Button>
              </>
            )}

            {/* Edit Key Panel */}
            {panel.type === "edit" && (
              <>
                <div className="space-y-2">
                  <Label>Label *</Label>
                  <Input
                    value={draftKey.label || ""}
                    onChange={(e) =>
                      setDraftKey({ ...draftKey, label: e.target.value })
                    }
                    placeholder="Key label"
                  />
                </div>

                <div className="space-y-2">
                  <Label className="text-destructive">Private key *</Label>
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
                  <Label className="text-muted-foreground">Public key</Label>
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
                  <Label className="text-muted-foreground">Certificate</Label>
                  <Textarea
                    value={draftKey.certificate || ""}
                    onChange={(e) =>
                      setDraftKey({ ...draftKey, certificate: e.target.value })
                    }
                    placeholder="Certificate content (optional)"
                    className="min-h-[60px] font-mono text-xs"
                  />
                </div>

                {/* Key Export section */}
                <div className="pt-4 mt-4 border-t border-border/60">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-sm font-medium">Key export</span>
                    <div className="h-4 w-4 rounded-full bg-muted flex items-center justify-center">
                      <Info size={10} className="text-muted-foreground" />
                    </div>
                  </div>
                  <Button
                    className="w-full h-11"
                    onClick={() => openKeyExport(panel.key)}
                  >
                    Export to host
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
                  Save Changes
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
