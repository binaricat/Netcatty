import React from "react";
import { ChevronDown, Eye, EyeOff, FileKey, FolderLock, FolderOpen, Key, KeyRound, MapPin, Plus, Shield, Trash2, User, X } from "lucide-react";
import type { Host } from "../types";
import { DistroAvatar } from "./DistroAvatar";
import { HostIconPicker } from "./HostIconPicker";
import { Button } from "./ui/button";
import { Combobox } from "./ui/combobox";
import { HostDetailsSection, HostDetailsSettingRow } from "./host-details";
import { Input } from "./ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { ScrollArea } from "./ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HostDetailsConnectionSectionsProps = Record<string, any>;

export const HostDetailsConnectionSections: React.FC<HostDetailsConnectionSectionsProps> = ({
  t,
  form,
  update,
  groupDefaults,
  selectedIdentity,
  clearIdentity,
  identities,
  identitySuggestionsOpen,
  filteredIdentitySuggestions,
  setIdentitySuggestionsOpen,
  availableKeys,
  applyIdentity,
  showPassword,
  setShowPassword,
  pendingReferenceKeyPath,
  setPendingReferenceKeyPath,
  selectedCredentialType,
  setSelectedCredentialType,
  credentialPopoverOpen,
  setCredentialPopoverOpen,
  keysByCategory,
  newKeyFilePath,
  setNewKeyFilePath,
  addLocalKeyFilePath,
  distroOptions,
  effectiveFormDistro,
  getDistroOptionLabel,
}) => {
  return (
  <>
        <HostDetailsSection
          icon={<MapPin size={14} className="text-muted-foreground" />}
          title={t("hostDetails.section.address")}
        >
          <div className="flex items-center gap-2">
            <DistroAvatar
              host={form as Host}
              fallback={
                form.label?.slice(0, 2).toUpperCase() ||
                form.hostname?.slice(0, 2).toUpperCase() ||
                "H"
              }
              className="h-10 w-10"
            />
            <Input
              placeholder={t("hostDetails.hostname.placeholder")}
              value={form.hostname}
              onChange={(e) => update("hostname", e.target.value)}
              className="h-10 flex-1"
            />
          </div>
        </HostDetailsSection>

        <HostDetailsSection
          icon={<KeyRound size={14} className="text-muted-foreground" />}
          title={t("hostDetails.section.portCredentials")}
          className="overflow-hidden"
        >
          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0 h-10 flex items-center gap-2 bg-secondary/70 border border-border/70 rounded-md px-3">
              <span className="text-xs text-muted-foreground">SSH on</span>
              <div className="ml-auto w-1/2 min-w-0 flex items-center gap-2 justify-end">
                <Input
                  type="number"
                  value={form.port ?? ""}
                  onChange={(e) => update("port", e.target.value ? Number(e.target.value) : undefined)}
                  placeholder={groupDefaults?.port ? String(groupDefaults.port) : "22"}
                  className="h-8 flex-1 min-w-0 text-center"
                />
                <span className="text-xs text-muted-foreground">
                  {t("hostDetails.port")}
                </span>
              </div>
            </div>
          </div>
          <div className="grid gap-2">
            {selectedIdentity ? (
              <div className="flex items-center gap-2 h-10 px-3 rounded-md border border-border/70 bg-secondary/60">
                <User size={16} className="text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">
                    {selectedIdentity.label}
                  </div>
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={clearIdentity}
                    >
                      <X size={14} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t("common.clear")}</TooltipContent>
                </Tooltip>
              </div>
            ) : form.identityId ? (
              <div className="flex items-center gap-2 h-10 px-3 rounded-md border border-border/70 bg-secondary/60">
                <User size={16} className="text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">
                    {t("hostDetails.identity.missing")}
                  </div>
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={clearIdentity}
                    >
                      <X size={14} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t("common.clear")}</TooltipContent>
                </Tooltip>
              </div>
            ) : (
              (() => {
                const hasIdentities = identities.length > 0;
                if (!hasIdentities) {
                  return (
                    <Input
                      placeholder={groupDefaults?.username || t("hostDetails.username.placeholder")}
                      value={form.username}
                      onChange={(e) => update("username", e.target.value)}
                      className="h-10"
                    />
                  );
                }

                return (
                  <Popover
                    open={
                      identitySuggestionsOpen &&
                      filteredIdentitySuggestions.length > 0
                    }
                    onOpenChange={setIdentitySuggestionsOpen}
                  >
                    <PopoverTrigger asChild>
                      <div className="relative">
                        <Input
                          placeholder={groupDefaults?.username || t("hostDetails.username.placeholder")}
                          value={form.username}
                          onChange={(e) => {
                            const next = e.target.value;
                            update("username", next);
                            const q = next.toLowerCase().trim();
                            const matches = q
                              ? identities.filter(
                                (i) =>
                                  i.label.toLowerCase().includes(q) ||
                                  i.username.toLowerCase().includes(q),
                              )
                              : identities;
                            setIdentitySuggestionsOpen(matches.length > 0);
                          }}
                          onFocus={() => {
                            const q = (form.username || "").toLowerCase().trim();
                            const matches = q
                              ? identities.filter(
                                (i) =>
                                  i.label.toLowerCase().includes(q) ||
                                  i.username.toLowerCase().includes(q),
                              )
                              : identities;
                            setIdentitySuggestionsOpen(matches.length > 0);
                          }}
                          className="h-10 pr-9"
                        />
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                              onClick={() => {
                                setIdentitySuggestionsOpen((prev) => {
                                  if (prev) return false;
                                  const q = (form.username || "")
                                    .toLowerCase()
                                    .trim();
                                  const matches = q
                                    ? identities.filter(
                                      (i) =>
                                        i.label.toLowerCase().includes(q) ||
                                        i.username.toLowerCase().includes(q),
                                    )
                                    : identities;
                                  return matches.length > 0;
                                });
                              }}
                            >
                              <ChevronDown size={16} />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>{t("hostDetails.identity.suggestions")}</TooltipContent>
                        </Tooltip>
                      </div>
                    </PopoverTrigger>
                    <PopoverContent
                      className="p-0 border-border/60"
                      align="start"
                      sideOffset={4}
                      onOpenAutoFocus={(e) => e.preventDefault()}
                      style={{ width: "var(--radix-popover-trigger-width)" }}
                    >
                      <ScrollArea className="max-h-[280px]">
                        <div className="p-1">
                          {filteredIdentitySuggestions.length === 0 ? (
                            <div className="py-4 text-center text-sm text-muted-foreground">
                              {t("common.noResultsFound")}
                            </div>
                          ) : (
                            <div className="space-y-1">
                              {filteredIdentitySuggestions.map((identity) => {
                                const keyLabel = identity.keyId
                                  ? availableKeys.find(
                                    (k) => k.id === identity.keyId,
                                  )?.label
                                  : undefined;
                                const methodLabel =
                                  identity.authMethod === "certificate"
                                    ? t("hostDetails.credential.certificate")
                                    : identity.authMethod === "key"
                                      ? t("hostDetails.credential.key")
                                      : t("keychain.identity.method.passwordOnly");
                                const summaryParts = [
                                  identity.username,
                                  identity.password ? "******" : undefined,
                                  keyLabel,
                                ].filter(Boolean);

                                return (
                                  <button
                                    key={identity.id}
                                    type="button"
                                    className="w-full flex items-center gap-3 px-3 py-2 rounded-md hover:bg-secondary/80 transition-colors text-left"
                                    onMouseDown={(e) => {
                                      e.preventDefault();
                                      applyIdentity(identity);
                                    }}
                                  >
                                    <div className="h-8 w-8 rounded-md bg-green-500/15 text-green-500 flex items-center justify-center shrink-0">
                                      <User size={16} />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                      <div className="text-sm font-medium truncate">
                                        {identity.label}
                                      </div>
                                      <div className="text-xs text-muted-foreground truncate">
                                        {methodLabel}
                                        {summaryParts.length
                                          ? ` - ${summaryParts.join(", ")}`
                                          : ""}
                                      </div>
                                    </div>
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </ScrollArea>
                    </PopoverContent>
                  </Popover>
                );
              })()
            )}

            {!selectedIdentity && !form.identityId && (
              <div className="relative">
                <Input
                  placeholder={t("hostDetails.password.placeholder")}
                  type={showPassword ? "text" : "password"}
                  value={form.password || ""}
                  onChange={(e) => update("password", e.target.value)}
                  className="h-10 pr-10"
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{showPassword ? t("hostDetails.password.hide") : t("hostDetails.password.show")}</TooltipContent>
                </Tooltip>
              </div>
            )}

            {/* Save Password toggle - shown when password is entered */}
            {!selectedIdentity && !form.identityId && form.password && (
              <div className="flex items-center justify-between py-1">
                <span className="text-xs text-muted-foreground">
                  {t("hostDetails.password.save")}
                </span>
                <Switch
                  checked={form.savePassword ?? true}
                  onCheckedChange={(val) => update("savePassword" as keyof Host, val)}
                />
              </div>
            )}

            {/* Local key file paths display */}
            {!selectedIdentity && !form.identityFileId && form.identityFilePaths && form.identityFilePaths.length > 0 && (
              <div className="space-y-1.5">
                {form.identityFilePaths.map((keyPath, idx) => (
                  <div key={idx} className="flex items-center gap-2 p-2 rounded-md bg-secondary/50 border border-border/60 overflow-hidden">
                    <FileKey size={14} className="text-primary shrink-0" />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="text-xs w-0 flex-1 truncate font-mono cursor-default">
                          {keyPath}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>{keyPath}</TooltipContent>
                    </Tooltip>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0"
                      onClick={() => {
                        const paths = form.identityFilePaths?.filter((_, i) => i !== idx) || [];
                        update("identityFilePaths", paths.length > 0 ? paths : undefined);
                        if (keyPath === pendingReferenceKeyPath) {
                          setPendingReferenceKeyPath(null);
                        }
                      }}
                    >
                      <Trash2 size={12} />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {/* Selected credential display */}
            {!selectedIdentity && form.identityFileId && (
              <div className="flex items-center gap-2 min-w-0 overflow-hidden p-2 rounded-md bg-secondary/50 border border-border/60">
                {form.authMethod === "certificate" ? (
                  <Shield size={14} className="text-primary shrink-0" />
                ) : (
                  <Key size={14} className="text-primary shrink-0" />
                )}
                <span className="text-sm min-w-0 flex-1 truncate">
                  {availableKeys.find((k) => k.id === form.identityFileId)
                    ?.label || "Key"}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0"
                  onClick={() => {
                    update("identityFileId", undefined);
                    update("authMethod", "password");
                    setPendingReferenceKeyPath(null);
                    setSelectedCredentialType(null);
                  }}
                >
                  <X size={12} />
                </Button>
              </div>
            )}

            {/* Credential type selection with inline popover - hidden when credential is selected */}
            {!selectedIdentity &&
              !form.identityFileId &&
              !selectedCredentialType && (
                <Popover
                  open={credentialPopoverOpen}
                  onOpenChange={setCredentialPopoverOpen}
                >
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
                    >
                      <Plus size={12} />
                      <span>{t("hostDetails.credential.keyCertificate")}</span>
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    className="w-[200px] p-1"
                    align="start"
                    sideOffset={4}
                  >
                    <div className="space-y-0.5">
                      <button
                        type="button"
                        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-secondary/80 transition-colors text-left"
                        onClick={() => {
                          setSelectedCredentialType("key");
                          setCredentialPopoverOpen(false);
                        }}
                      >
                        <Key size={16} className="text-muted-foreground" />
                        <span className="text-sm font-medium">
                          {t("hostDetails.credential.key")}
                        </span>
                      </button>

                      <button
                        type="button"
                        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-secondary/80 transition-colors text-left"
                        onClick={() => {
                          setSelectedCredentialType("certificate");
                          setCredentialPopoverOpen(false);
                        }}
                      >
                        <Shield size={16} className="text-muted-foreground" />
                        <span className="text-sm font-medium">
                          {t("hostDetails.credential.certificate")}
                        </span>
                      </button>

                      <button
                        type="button"
                        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-secondary/80 transition-colors text-left"
                        onClick={() => {
                          setSelectedCredentialType("localKeyFile");
                          setCredentialPopoverOpen(false);
                        }}
                      >
                        <FileKey size={16} className="text-muted-foreground" />
                        <span className="text-sm font-medium">
                          {t("hostDetails.credential.localKeyFile")}
                        </span>
                      </button>
                    </div>
                  </PopoverContent>
                </Popover>
              )}

            {/* Key selection combobox - appears after selecting "Key" type */}
            {!selectedIdentity &&
              selectedCredentialType === "key" &&
              !form.identityFileId && (
                <div className="flex items-center gap-1">
                  <Combobox
                    options={keysByCategory.key.map((k) => ({
                      value: k.id,
                      label: k.label,
                      sublabel: `${k.type}${k.keySize ? ` ${k.keySize}` : ""}`,
                      icon: <Key size={14} className="text-muted-foreground" />,
                    }))}
                    value={form.identityFileId}
                    onValueChange={(val) => {
                      update("identityFileId", val);
                      update("authMethod", "key");
                      update("identityFilePaths", undefined);
                      setPendingReferenceKeyPath(null);
                      setSelectedCredentialType(null);
                    }}
                    placeholder={t("hostDetails.keys.search")}
                    emptyText={t("hostDetails.keys.empty")}
                    icon={<Key size={14} className="text-muted-foreground" />}
                    className="flex-1"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    onClick={() => setSelectedCredentialType(null)}
                  >
                    <X size={14} />
                  </Button>
                </div>
              )}

            {/* Certificate selection combobox - appears after selecting "Certificate" type */}
            {!selectedIdentity &&
              selectedCredentialType === "certificate" &&
              !form.identityFileId && (
                <div className="flex items-center gap-1">
                  <Combobox
                    options={keysByCategory.certificate.map((k) => ({
                      value: k.id,
                      label: k.label,
                      icon: (
                        <Shield size={14} className="text-muted-foreground" />
                      ),
                    }))}
                    value={form.identityFileId}
                    onValueChange={(val) => {
                      update("identityFileId", val);
                      update("authMethod", "certificate");
                      update("identityFilePaths", undefined);
                      setPendingReferenceKeyPath(null);
                      setSelectedCredentialType(null);
                    }}
                    placeholder={t("hostDetails.certs.search")}
                    emptyText={t("hostDetails.certs.empty")}
                    icon={
                      <Shield size={14} className="text-muted-foreground" />
                    }
                    className="flex-1"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    onClick={() => setSelectedCredentialType(null)}
                  >
                    <X size={14} />
                  </Button>
                </div>
              )}

            {/* Local key file path input - appears after selecting "Local Key File" type */}
            {!selectedIdentity &&
              selectedCredentialType === "localKeyFile" &&
              !form.identityFileId && (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-1 min-w-0">
                    <input
                      type="text"
                      className="flex-1 min-w-0 h-8 px-2 text-xs font-mono bg-background border border-border/60 rounded-md focus:outline-none focus:ring-1 focus:ring-ring"
                      placeholder={t("hostDetails.credential.localKeyFilePlaceholder")}
                      value={newKeyFilePath}
                      onChange={(e) => setNewKeyFilePath(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && newKeyFilePath.trim()) {
                          e.preventDefault();
                          addLocalKeyFilePath(newKeyFilePath);
                        }
                      }}
                    />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="secondary"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          onClick={async () => {
                            const bridge = (window as unknown as { netcatty?: NetcattyBridge }).netcatty;
                            if (!bridge?.selectFile) return;
                            const filePath = await bridge.selectFile(
                              "Select SSH Private Key",
                              undefined,
                              [{ name: "All Files", extensions: ["*"] }]
                            );
                            if (filePath) {
                              addLocalKeyFilePath(filePath);
                            }
                          }}
                        >
                          <FolderOpen size={14} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t("hostDetails.credential.browseKeyFile")}</TooltipContent>
                    </Tooltip>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() => {
                        setSelectedCredentialType(null);
                        setNewKeyFilePath("");
                      }}
                    >
                      <X size={14} />
                    </Button>
                  </div>
                </div>
              )}
          </div>
        </HostDetailsSection>

        <HostDetailsSection
          icon={<FolderLock size={14} className="text-muted-foreground" />}
          title={t("hostDetails.section.sftp")}
        >
          <HostDetailsSettingRow
            label={t("hostDetails.sftp.sudo")}
            hint={t("hostDetails.sftp.sudo.desc")}
          >
            <Switch
              checked={form.sftpSudo || false}
              onCheckedChange={(val) => update("sftpSudo", val)}
            />
          </HostDetailsSettingRow>
          {form.sftpSudo && !form.password && !selectedIdentity?.password && (
            <p className="text-xs text-amber-500">
              {t("hostDetails.sftp.sudo.passwordWarning")}
            </p>
          )}
          <HostDetailsSettingRow
            label={t("hostDetails.sftp.encoding")}
            hint={t("hostDetails.sftp.encoding.desc")}
          >
            <Select
              value={form.sftpEncoding || "auto"}
              onValueChange={(val) => update("sftpEncoding", val as Host["sftpEncoding"])}
            >
              <SelectTrigger className="h-10 w-32">
                <SelectValue placeholder={t("sftp.encoding.label")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t("sftp.encoding.auto")}</SelectItem>
                <SelectItem value="utf-8">{t("sftp.encoding.utf8")}</SelectItem>
                <SelectItem value="gb18030">{t("sftp.encoding.gb18030")}</SelectItem>
              </SelectContent>
            </Select>
          </HostDetailsSettingRow>
        </HostDetailsSection>

        <HostDetailsSection
          icon={<DistroAvatar host={form as Host} fallback="H" size="sm" />}
          title={t("hostDetails.icon.sectionTitle")}
          hint={t("hostDetails.icon.desc")}
        >
          <HostIconPicker
            distroMode={form.distroMode}
            manualDistro={form.manualDistro}
            effectiveDistro={effectiveFormDistro}
            distroOptions={distroOptions}
            getDistroOptionLabel={getDistroOptionLabel}
            iconMode={form.iconMode}
            iconId={form.iconId}
            iconColorMode={form.iconColorMode}
            iconColor={form.iconColor}
            iconColorCustom={form.iconColorCustom}
            onChange={(next) => {
              if ("distroMode" in next) update("distroMode", next.distroMode);
              if ("manualDistro" in next) update("manualDistro", next.manualDistro);
              if ("iconMode" in next) update("iconMode", next.iconMode);
              if ("iconId" in next) update("iconId", next.iconId);
              if ("iconColorMode" in next) update("iconColorMode", next.iconColorMode);
              if ("iconColor" in next) update("iconColor", next.iconColor);
              if ("iconColorCustom" in next) update("iconColorCustom", next.iconColorCustom);
            }}
          />
        </HostDetailsSection>
  </>
  );
};
