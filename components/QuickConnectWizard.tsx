import {
  ArrowLeft,
  ChevronDown,
  Eye,
  EyeOff,
  Key,
  Lock,
  Plug,
  Plus,
  User,
} from "lucide-react";
import React, { useMemo, useState } from "react";
import { useI18n } from "../application/i18n/I18nProvider";
import type { QuickConnectTarget } from "../domain/quickConnect";
import { formatHostPort } from "../domain/host";
import {
  buildQuickConnectHost,
  getQuickConnectDefaultPort,
  isQuickConnectIdentityUsable,
  type QuickConnectAuthMethod,
  type QuickConnectProtocol,
} from "../domain/quickConnectHost";
import { cn } from "../lib/utils";
import { Host, Identity, SSHKey } from "../types";
import { Button } from "./ui/button";
import { Combobox } from "./ui/combobox";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Dropdown, DropdownContent, DropdownTrigger } from "./ui/dropdown";
import { ScrollArea } from "./ui/scroll-area";
import { PROTOCOL_VISUAL_STYLES } from "./protocolVisuals";



// Wizard steps
type WizardStep = "protocol" | "username" | "knownhost" | "auth";

interface QuickConnectWizardProps {
  open: boolean;
  target: QuickConnectTarget;
  keys: SSHKey[];
  identities: Identity[];
  warnings?: string[];
  onConnect: (host: Host) => void;
  onSaveHost?: (host: Host) => void;
  onAddKey?: () => void;
  onClose: () => void;
}

const QuickConnectWizard: React.FC<QuickConnectWizardProps> = ({
  open,
  target,
  keys,
  identities,
  warnings,
  onConnect,
  onSaveHost,
  onAddKey,
  onClose,
}) => {
  const { t } = useI18n();
  // Wizard state
  const [step, setStep] = useState<WizardStep>("protocol");
  const [protocol, setProtocol] = useState<QuickConnectProtocol>("ssh");
  const [username, setUsername] = useState(target.username || "");
  const [port, setPort] = useState<number>(target.port || 22);

  // Known host verification state
  const [knownHostInfo, setKnownHostInfo] = useState<{
    keyType: string;
    fingerprint: string;
  } | null>(null);

  // Auth state
  const [authMethod, setAuthMethod] = useState<QuickConnectAuthMethod>("password");
  const [password, setPassword] = useState("");
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
  const [selectedIdentityId, setSelectedIdentityId] = useState<string | null>(null);
  const [saveOptionsOpen, setSaveOptionsOpen] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const selectedIdentity = useMemo(
    () => identities.find((identity) => identity.id === selectedIdentityId),
    [identities, selectedIdentityId],
  );

  // Reset state when target changes
  React.useEffect(() => {
    if (open) {
      setStep("protocol");
      setProtocol("ssh");
      setUsername(target.username || "");
      setPort(target.port || 22);
      setPassword("");
      setSelectedKeyId(null);
      setSelectedIdentityId(null);
      setSaveOptionsOpen(false);
      setShowPassword(false);
      setKnownHostInfo(null);
    }
  }, [open, target]);

  const canUseSelectedIdentity = useMemo(
    () => isQuickConnectIdentityUsable(selectedIdentity, keys, protocol),
    [keys, protocol, selectedIdentity],
  );
  const identityOptions = useMemo(
    () => identities.map((identity) => ({
      value: identity.id,
      label: identity.label,
      sublabel: identity.username,
      icon: <User size={14} />,
    })),
    [identities],
  );

  const detachSelectedIdentity = () => {
    setSelectedIdentityId(null);
    setAuthMethod("password");
    setPassword("");
    setSelectedKeyId(null);
  };

  const clearSelectedIdentity = () => {
    detachSelectedIdentity();
    setUsername(target.username || "");
  };

  const handleIdentitySelect = (identityId: string) => {
    if (!identityId) {
      clearSelectedIdentity();
      return;
    }
    const identity = identities.find((candidate) => candidate.id === identityId);
    if (!identity) return;
    setSelectedIdentityId(identity.id);
    setUsername(identity.username);
    setAuthMethod(identity.authMethod);
    setPassword("");
    setSelectedKeyId(identity.keyId || null);
  };

  // Handle protocol selection
  const handleProtocolSelect = (proto: QuickConnectProtocol) => {
    setProtocol(proto);
    if (proto === "telnet") {
      if (selectedIdentityId) clearSelectedIdentity();
      setAuthMethod("password");
    }
    if (port === getQuickConnectDefaultPort(protocol)) {
      setPort(getQuickConnectDefaultPort(proto));
    }
  };

  const handleProtocolPortChange = (
    proto: QuickConnectProtocol,
    rawValue: string,
    fallbackPort: number,
  ) => {
    handleProtocolSelect(proto);
    setPort(parseInt(rawValue) || fallbackPort);
  };

  // Navigate to next step
  const handleContinue = () => {
    switch (step) {
      case "protocol":
        if (canUseSelectedIdentity) {
          handleConnect();
          break;
        }
        // Always go to username step to let user confirm/edit username
        setStep("username");
        break;
      case "username":
        setStep("auth");
        break;
      case "knownhost":
        setStep("auth");
        break;
      case "auth":
        handleConnect();
        break;
    }
  };

  // Navigate back
  const handleBack = () => {
    switch (step) {
      case "username":
        setStep("protocol");
        break;
      case "knownhost":
        setStep("username");
        break;
      case "auth":
        // Always go back to username step
        setStep("username");
        break;
    }
  };

  // Create host and connect
  const handleConnect = (save = false) => {
    const effectiveUsername = username || target.username || "root";
    const effectivePort = port || getQuickConnectDefaultPort(protocol);
    const now = Date.now();
    const tempHost = buildQuickConnectHost({
      id: `quick-${now}-${Math.random().toString(36).slice(2, 11)}`,
      createdAt: now,
      target,
      protocol,
      port: effectivePort,
      username: effectiveUsername,
      authMethod,
      password,
      selectedKeyId,
      selectedIdentityId: selectedIdentity?.id,
      save,
    });

    if (save && onSaveHost) {
      onSaveHost(tempHost);
    }

    onConnect(tempHost);
    onClose();
  };

  // Check if can proceed
  const canProceed = useMemo(() => {
    switch (step) {
      case "protocol":
        return true;
      case "username":
        return username.trim().length > 0;
      case "knownhost":
        return true;
      case "auth":
        if (selectedIdentity && protocol !== "telnet") return canUseSelectedIdentity;
        if (authMethod === "password") {
          // Whitespace-only passwords are valid SSH secrets (issue #2036).
          return password.length > 0;
        }
        return Boolean(selectedKeyId && keys.some((key) => key.id === selectedKeyId));
    }
  }, [
    step,
    username,
    authMethod,
    password,
    selectedKeyId,
    selectedIdentity,
    canUseSelectedIdentity,
    keys,
    protocol,
  ]);

  // Render protocol selection step
  const renderProtocolStep = () => (
    <div className="space-y-6">
      <div className="space-y-4">
      <h3 className="text-sm font-medium">{t("protocolSelect.chooseProtocol")}</h3>
      <div className="space-y-3">
        {/* SSH */}
        <button
          className={cn(
            "w-full flex items-center justify-between px-4 py-3 rounded-xl border-2 transition-all text-left",
            protocol === "ssh"
              ? "border-primary bg-primary/5"
              : "border-border/60 hover:border-border hover:bg-secondary/50",
          )}
          onClick={() => handleProtocolSelect("ssh")}
        >
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "h-10 w-10 rounded-lg flex items-center justify-center",
                protocol === "ssh"
                  ? PROTOCOL_VISUAL_STYLES.ssh.selected
                  : PROTOCOL_VISUAL_STYLES.ssh.idle,
              )}
            >
              {PROTOCOL_VISUAL_STYLES.ssh.icon}
            </div>
            <div>
              <div className="font-medium">SSH</div>
              <div className="text-xs text-muted-foreground font-mono">
                ssh {target.hostname}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t("protocolSelect.port")}</span>
            <Input
              type="number"
              value={protocol === "ssh" ? port : 22}
              onChange={(e) => handleProtocolPortChange("ssh", e.target.value, 22)}
              onClick={(e) => e.stopPropagation()}
              className="w-16 h-7 text-xs text-center"
              min={1}
              max={65535}
            />
          </div>
        </button>

        {/* Mosh */}
        <button
          className={cn(
            "w-full flex items-center justify-between px-4 py-3 rounded-xl border-2 transition-all text-left",
            protocol === "mosh"
              ? "border-primary bg-primary/5"
              : "border-border/60 hover:border-border hover:bg-secondary/50",
          )}
          onClick={() => handleProtocolSelect("mosh")}
        >
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "h-10 w-10 rounded-lg flex items-center justify-center",
                protocol === "mosh"
                  ? PROTOCOL_VISUAL_STYLES.mosh.selected
                  : PROTOCOL_VISUAL_STYLES.mosh.idle,
              )}
            >
              {PROTOCOL_VISUAL_STYLES.mosh.icon}
            </div>
            <div>
              <div className="font-medium">Mosh</div>
              <div className="text-xs text-muted-foreground font-mono">
                mosh {target.hostname}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t("protocolSelect.port")}</span>
            <Input
              type="number"
              value={protocol === "mosh" ? port : 22}
              onChange={(e) => handleProtocolPortChange("mosh", e.target.value, 22)}
              onClick={(e) => e.stopPropagation()}
              className="w-16 h-7 text-xs text-center"
              min={1}
              max={65535}
            />
          </div>
        </button>

        {/* Eternal Terminal */}
        <button
          className={cn(
            "w-full flex items-center justify-between px-4 py-3 rounded-xl border-2 transition-all text-left",
            protocol === "et"
              ? "border-primary bg-primary/5"
              : "border-border/60 hover:border-border hover:bg-secondary/50",
          )}
          onClick={() => handleProtocolSelect("et")}
        >
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "h-10 w-10 rounded-lg flex items-center justify-center",
                protocol === "et"
                  ? PROTOCOL_VISUAL_STYLES.et.selected
                  : PROTOCOL_VISUAL_STYLES.et.idle,
              )}
            >
              {PROTOCOL_VISUAL_STYLES.et.icon}
            </div>
            <div>
              <div className="font-medium">Eternal Terminal</div>
              <div className="text-xs text-muted-foreground font-mono">
                et {target.hostname}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t("protocolSelect.port")}</span>
            <Input
              type="number"
              value={protocol === "et" ? port : 22}
              onChange={(e) => handleProtocolPortChange("et", e.target.value, 22)}
              onClick={(e) => e.stopPropagation()}
              className="w-16 h-7 text-xs text-center"
              min={1}
              max={65535}
            />
          </div>
        </button>

        {/* Telnet */}
        <button
          className={cn(
            "w-full flex items-center justify-between px-4 py-3 rounded-xl border-2 transition-all text-left",
            protocol === "telnet"
              ? "border-primary bg-primary/5"
              : "border-border/60 hover:border-border hover:bg-secondary/50",
          )}
          onClick={() => handleProtocolSelect("telnet")}
        >
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "h-10 w-10 rounded-lg flex items-center justify-center",
                protocol === "telnet"
                  ? PROTOCOL_VISUAL_STYLES.telnet.selected
                  : PROTOCOL_VISUAL_STYLES.telnet.idle,
              )}
            >
              {PROTOCOL_VISUAL_STYLES.telnet.icon}
            </div>
            <div>
              <div className="font-medium">Telnet</div>
              <div className="text-xs text-muted-foreground font-mono">
                telnet {target.hostname}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t("protocolSelect.port")}</span>
            <Input
              type="number"
              value={protocol === "telnet" ? port : 23}
              onChange={(e) => handleProtocolPortChange("telnet", e.target.value, 23)}
              onClick={(e) => e.stopPropagation()}
              className="w-16 h-7 text-xs text-center"
              min={1}
              max={65535}
            />
          </div>
        </button>
      </div>
      </div>

      {protocol !== "telnet" && identities.length > 0 && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3">
            <Label className="text-sm font-medium">{t("quickConnect.identity.label")}</Label>
            <Combobox
              options={identityOptions}
              value={selectedIdentityId || undefined}
              onValueChange={handleIdentitySelect}
              placeholder={t("quickConnect.identity.placeholder")}
              emptyText={t("quickConnect.identity.empty")}
              icon={<User size={14} />}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {selectedIdentity
              ? t("quickConnect.identity.selectedHint", { username: selectedIdentity.username })
              : t("quickConnect.identity.hint")}
          </p>
        </div>
      )}
    </div>
  );

  // Render username step
  const renderUsernameStep = () => (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="quick-username">{t("terminal.auth.username")}</Label>
        <Input
          id="quick-username"
          value={username}
          onChange={(e) => {
            if (selectedIdentityId) detachSelectedIdentity();
            setUsername(e.target.value);
          }}
          placeholder={t("terminal.auth.username.placeholder")}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter" && username.trim()) {
              handleContinue();
            }
          }}
        />
      </div>
    </div>
  );

  // Render known host verification step
  const renderKnownHostStep = () => (
    <div className="space-y-4">
      <h3 className="text-base font-semibold text-amber-600 dark:text-amber-500">
        {t("quickConnect.knownHost.title")}
      </h3>
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>{t("quickConnect.knownHost.authenticity", { hostname: target.hostname })}</p>
        {knownHostInfo && (
          <>
            <p className="font-medium text-foreground">
              {t("quickConnect.knownHost.fingerprintLabel", { keyType: knownHostInfo.keyType })}
            </p>
            <p className="font-mono text-xs bg-muted p-2 rounded break-all">
              {knownHostInfo.fingerprint}
            </p>
          </>
        )}
        <p>{t("quickConnect.knownHost.addQuestion")}</p>
      </div>
    </div>
  );

  // Render auth step
  const renderAuthStep = () => (
    <div className="space-y-4">
      {selectedIdentity ? (
        <div className="rounded-xl border border-primary/40 bg-primary/5 p-4 space-y-3">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-primary/15 text-primary flex items-center justify-center">
              <User size={16} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-medium truncate">{selectedIdentity.label}</div>
              <div className="text-xs text-muted-foreground truncate">
                {selectedIdentity.username} · {t(`quickConnect.identity.method.${selectedIdentity.authMethod}`)}
              </div>
            </div>
          </div>
          {!canUseSelectedIdentity && (
            <p className="text-xs text-destructive">
              {t("quickConnect.identity.unavailable")}
            </p>
          )}
          <Button variant="outline" size="sm" className="w-full" onClick={detachSelectedIdentity}>
            {t("quickConnect.identity.useCustom")}
          </Button>
        </div>
      ) : (
        <>
      {/* Auth method tabs */}
      <div className="flex gap-1 p-1 bg-secondary/80 rounded-lg border border-border/60">
        <button
          className={cn(
            "flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-md transition-all",
            authMethod === "password"
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground hover:bg-secondary",
          )}
          onClick={() => {
            setSelectedIdentityId(null);
            setAuthMethod("password");
          }}
        >
          <Lock size={14} />
          {t("terminal.auth.password")}
        </button>
        <button
          className={cn(
            "flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-md transition-all",
            authMethod !== "password"
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground hover:bg-secondary",
          )}
          onClick={() => {
            setSelectedIdentityId(null);
            setAuthMethod("key");
          }}
        >
          <Key size={14} />
          {t("terminal.auth.sshKey")}
        </button>
      </div>

      {/* Password field */}
      {authMethod === "password" && (
        <div className="space-y-2">
          <Label htmlFor="quick-password">{t("terminal.auth.passwordLabel")}</Label>
          <div className="relative">
            <Input
              id="quick-password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("terminal.auth.password.placeholder")}
              className="pr-10"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && password.length > 0) {
                  handleConnect();
                }
              }}
            />
            <button
              type="button"
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => setShowPassword(!showPassword)}
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>
      )}

      {/* Key selection */}
      {authMethod === "key" && (
        <div className="space-y-2">
          {keys.filter((k) => k.category === "key").length === 0 ? (
            <div className="text-sm text-muted-foreground p-3 border border-dashed border-border/60 rounded-lg text-center">
              {t("terminal.auth.noKeysHint")}
            </div>
          ) : (
            <ScrollArea className="max-h-48">
              <div className="space-y-2">
                {keys
                  .filter((k) => k.category === "key")
                  .map((key) => (
                    <button
                      key={key.id}
                      className={cn(
                        "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors text-left",
                        selectedKeyId === key.id
                          ? "border-primary bg-primary/5"
                          : "border-border/50 hover:bg-secondary/50",
                      )}
                      onClick={() => {
                        setSelectedIdentityId(null);
                        setSelectedKeyId(key.id);
                      }}
                    >
                      <div
                        className={cn(
                          "h-8 w-8 rounded-lg flex items-center justify-center",
                          "bg-primary/20 text-primary",
                        )}
                      >
                        <Key size={14} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">
                          {key.label}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Type {key.type}
                        </div>
                      </div>
                    </button>
                  ))}
              </div>
            </ScrollArea>
          )}

          {onAddKey && (
            <Button
              variant="outline"
              size="sm"
              className="w-full mt-2"
              onClick={onAddKey}
            >
              <Plus size={14} className="mr-2" />
              Add key
            </Button>
          )}
        </div>
      )}
        </>
      )}
    </div>
  );

  const hostEndpoint = formatHostPort(target.hostname, port || getQuickConnectDefaultPort(protocol));
  const connectTitle = t("quickConnect.connectTitle", { host: hostEndpoint });
  const protocolLabel = protocol === "et" ? "ET" : protocol.toUpperCase();
  const effectiveUsername = username || target.username || "";
  const connectSubtitle = step === "protocol"
    ? null
    : (
      effectiveUsername
        ? `${protocolLabel} ${effectiveUsername}@${hostEndpoint}`
        : `${protocolLabel} ${hostEndpoint}`
    );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="w-[560px] max-w-[90vw] bg-background border border-border rounded-2xl animate-in fade-in-0 zoom-in-95 duration-200"
        style={{
          boxShadow:
            "0 25px 50px -12px rgba(0, 0, 0, 0.25), 0 12px 24px -8px rgba(0, 0, 0, 0.15)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-border/50">
          <div className="flex items-center gap-2 min-w-0">
            <Plug size={18} className="shrink-0 text-foreground" />
            <div className="min-w-0">
              <h2 className="text-base font-semibold truncate">{connectTitle}</h2>
              {connectSubtitle ? (
                <p className="text-xs text-muted-foreground font-mono truncate">{connectSubtitle}</p>
              ) : null}
            </div>
          </div>
        </div>


        {warnings && warnings.length > 0 && (
          <div className="px-6 pb-2">
            <div className="text-xs text-amber-600 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
              {t("quickConnect.warning.unparsedOptions", {
                options: warnings.join(", "),
              })}
            </div>
          </div>
        )}

        {/* Content */}
        <div className="px-6 py-4">
          {step === "protocol" && renderProtocolStep()}
          {step === "username" && renderUsernameStep()}
          {step === "knownhost" && renderKnownHostStep()}
          {step === "auth" && renderAuthStep()}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-border/50 flex items-center justify-between">
          <Button
            variant="secondary"
            onClick={step === "protocol" ? onClose : handleBack}
          >
            {step === "protocol" ? (
              t("common.close")
            ) : (
              <>
                <ArrowLeft size={14} className="mr-2" />
                {t("common.back")}
              </>
            )}
          </Button>

          {step === "knownhost" ? (
            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={handleContinue}>
                {t("common.continue")}
              </Button>
              <Button
                onClick={() => {
                  // Add to known hosts then continue
                  handleContinue();
                }}
              >
                {t("quickConnect.knownHost.addAndContinue")}
              </Button>
            </div>
          ) : step === "auth" ? (
            <div className="flex items-center gap-2">
              {onAddKey &&
                authMethod === "key" &&
                keys.filter((k) => k.category === "key").length === 0 && (
                  <Button variant="secondary" onClick={onAddKey}>
                    {t("quickConnect.addKey")}
                  </Button>
                )}
              <Dropdown open={saveOptionsOpen} onOpenChange={setSaveOptionsOpen}>
                <div className="flex items-center rounded-md bg-primary text-primary-foreground">
                  <Button
                    disabled={!canProceed}
                    onClick={() => handleConnect(false)}
                    className="rounded-r-none bg-transparent hover:bg-white/10 shadow-none"
                  >
                    {t("common.continue")}
                  </Button>
                  <DropdownTrigger asChild>
                    <Button
                      disabled={!canProceed}
                      aria-label={t("terminal.auth.continueSave")}
                      aria-haspopup="menu"
                      aria-expanded={saveOptionsOpen}
                      className="px-2 rounded-l-none bg-transparent hover:bg-white/10 border-l border-primary-foreground/20 shadow-none"
                    >
                      <ChevronDown size={14} />
                    </Button>
                  </DropdownTrigger>
                </div>
                <DropdownContent className="w-44 p-1 z-50" align="end">
                  <button
                    className="w-full px-3 py-2 text-sm text-left hover:bg-secondary rounded-md"
                    onClick={() => handleConnect(true)}
                    disabled={!canProceed}
                  >
                    {t("terminal.auth.continueSave")}
                  </button>
                </DropdownContent>
              </Dropdown>
            </div>
          ) : (
            <Button onClick={handleContinue} disabled={!canProceed}>
              {step === "protocol" && canUseSelectedIdentity
                ? t("quickConnect.identity.connect")
                : t("common.continue")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

export default QuickConnectWizard;
