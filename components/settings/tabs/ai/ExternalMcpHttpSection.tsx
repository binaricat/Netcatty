import React, { useEffect, useId, useState } from "react";
import {
  buildClaudeHttpAddCommand,
  buildCodexHttpEnvLine,
  buildCodexHttpToml,
  buildExternalMcpHttpUrl,
  buildGenericHttpMcpJson,
  DEFAULT_EXTERNAL_MCP_HTTP_PORT,
} from "../../../../domain/externalMcpHttp";
import { useI18n } from "../../../../application/i18n/I18nProvider";
import { cn } from "../../../../lib/utils";
import { Button } from "../../../ui/button";
import { SettingCard, SettingRow, Toggle } from "../../settings-ui";
import { ToolSettingsDialog } from "./ToolSettingsDialog";
import { useOptionalSettingsFocus } from "../../SettingsFocusContext";
import { SettingsAnchor } from "../../settings-ui";
import { CopyableCodeBlock } from "./CopyableCodeBlock";

export type ExternalMcpHttpViewStatus = {
  enabled?: boolean;
  listening?: boolean;
  port?: number;
  listenAddress?: string;
  allowCustomBind?: boolean;
  clientHost?: string;
  url?: string | null;
  bearerToken?: string | null;
  state?: string;
  error?: string | null;
  errorCode?: string | null;
};

export type ExternalMcpHttpViewSettings = {
  enabled: boolean;
  port: number;
  allowCustomBind: boolean;
  listenAddress: string;
  clientHost: string;
};

type ExternalMcpHttpSectionProps = {
  externalMcpEnabled: boolean;
  settings: ExternalMcpHttpViewSettings;
  status: ExternalMcpHttpViewStatus | null;
  copied: string | null;
  rotating: boolean;
  onCopy: (key: string, text: string) => void;
  onChange: (next: ExternalMcpHttpViewSettings) => void;
  onRotateToken: () => void;
};

function isWildcardAddress(value: string): boolean {
  const address = value.trim();
  return address === "0.0.0.0" || address === "::";
}

function isIpAddress(value: string): boolean {
  const address = value.trim();
  const ipv4 = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    return ipv4.slice(1).every((part) => Number(part) <= 255 && String(Number(part)) === part);
  }
  return address.includes(":") && /^[0-9a-fA-F:]+$/.test(address);
}

function parsePort(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
  return port;
}

export const ExternalMcpHttpSection: React.FC<ExternalMcpHttpSectionProps> = ({
  externalMcpEnabled,
  settings,
  status,
  copied,
  rotating,
  onCopy,
  onChange,
  onRotateToken,
}) => {
  const { t } = useI18n();
  const errorId = useId();
  const [open, setOpen] = useState(false);
  const focus = useOptionalSettingsFocus();
  useEffect(() => {
    if (focus?.request?.anchorId === "ai-external-mcp-http") setOpen(true);
  }, [focus?.request]);
  const [portDraft, setPortDraft] = useState(String(settings.port || DEFAULT_EXTERNAL_MCP_HTTP_PORT));
  const [addressDraft, setAddressDraft] = useState(settings.listenAddress || "0.0.0.0");
  const [clientHostDraft, setClientHostDraft] = useState(settings.clientHost || "");
  const [portError, setPortError] = useState(false);
  const [addressError, setAddressError] = useState(false);
  const [clientHostError, setClientHostError] = useState(false);

  const changeOpen = (next: boolean) => {
    setPortDraft(String(settings.port || DEFAULT_EXTERNAL_MCP_HTTP_PORT));
    setAddressDraft(settings.listenAddress || "0.0.0.0");
    setClientHostDraft(settings.clientHost || "");
    setPortError(false);
    setAddressError(false);
    setClientHostError(false);
    setOpen(next);
  };

  const listenAddress = settings.allowCustomBind
    ? (status?.listenAddress || settings.listenAddress)
    : "127.0.0.1";
  const advertisedHost = status?.clientHost ?? settings.clientHost;
  const url = status
    ? (status.url || "")
    : buildExternalMcpHttpUrl(listenAddress, settings.port, advertisedHost);
  const showClientHost = settings.allowCustomBind && (
    isWildcardAddress(settings.listenAddress) || isWildcardAddress(addressDraft)
  );
  const token = status?.bearerToken || "";
  const listening = Boolean(status?.listening);
  const statusLabel = listening
    ? t("ai.externalMcp.http.listening")
    : t("ai.externalMcp.http.notListening");
  const statusClass = status?.errorCode
    ? "text-destructive"
    : listening
      ? "text-emerald-500"
      : "text-muted-foreground";

  let errorText = "";
  if (portError) errorText = t("ai.externalMcp.http.invalidPort");
  else if (addressError) errorText = t("ai.externalMcp.http.invalidAddress");
  else if (clientHostError) errorText = t("ai.externalMcp.http.invalidClientHost");
  else if (status?.errorCode === "client_host_required") errorText = t("ai.externalMcp.http.clientHostRequired");
  else if (status?.errorCode === "port_in_use") {
    errorText = t("ai.externalMcp.http.portInUse", { port: String(status.port ?? settings.port) });
  } else if (status?.errorCode === "invalid_address") errorText = t("ai.externalMcp.http.invalidAddress");
  else if (status?.errorCode === "invalid_port") errorText = t("ai.externalMcp.http.invalidPort");
  else if (status?.errorCode === "listen_failed") errorText = status.error || t("ai.externalMcp.http.listenFailed");

  const commitPort = () => {
    const port = parsePort(portDraft);
    if (port == null) {
      setPortError(true);
      return;
    }
    setPortError(false);
    setPortDraft(String(port));
    if (port !== settings.port) onChange({ ...settings, port });
  };

  const commitClientHost = () => {
    const clientHost = clientHostDraft.trim();
    if (clientHost && (!isIpAddress(clientHost) || isWildcardAddress(clientHost))) {
      setClientHostError(true);
      return;
    }
    setClientHostError(false);
    setClientHostDraft(clientHost);
    if (clientHost !== settings.clientHost) onChange({ ...settings, clientHost });
  };

  const commitAddress = () => {
    const address = addressDraft.trim();
    if (!isIpAddress(address)) {
      setAddressError(true);
      return;
    }
    setAddressError(false);
    setAddressDraft(address);
    if (address !== settings.listenAddress) onChange({ ...settings, listenAddress: address });
  };

  return (
    <SettingsAnchor anchorId="ai-external-mcp-http" className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-semibold text-foreground">{t("ai.externalMcp.http.title")}</div>
        <div className={cn("text-xs font-medium", statusClass)}>{statusLabel}</div>
      </div>
      <p className="text-xs text-muted-foreground leading-5">{t("ai.externalMcp.http.description")}</p>
      <p className="text-xs text-muted-foreground leading-5">{t("ai.externalMcp.http.legacySseNote")}</p>
      <SettingCard>
        <SettingRow className="flex-col items-start md:flex-row md:items-center" label={t(settings.enabled ? "ai.toolSettings.httpOn" : "ai.toolSettings.httpOff")} description={settings.allowCustomBind ? t("ai.externalMcp.http.warning") : t("ai.toolSettings.loopback")}>
          <ToolSettingsDialog title={t("ai.externalMcp.http.title")} triggerLabel={t("ai.toolSettings.configureHttp")} immediate open={open} onOpenChange={changeOpen}>
      <p className="text-xs text-muted-foreground leading-5">{t("ai.externalMcp.http.description")}</p>
      <SettingCard divided className="border-0 bg-transparent p-0">
        <SettingRow
          label={t("ai.externalMcp.http.enable")}
        >
          <Toggle
            checked={settings.enabled}
            onChange={(enabled) => onChange({ ...settings, enabled })}
            ariaLabel={t("ai.externalMcp.http.enable")}
          />
        </SettingRow>
        <SettingRow
          label={t("ai.externalMcp.http.port")}
          description={t("ai.externalMcp.http.portHint")}
        >
          <input
            type="number"
            aria-label={t("ai.externalMcp.http.port")}
            aria-invalid={portError}
            aria-describedby={portError ? errorId : undefined}
            min={1024}
            max={65535}
            value={portDraft}
            onChange={(event) => {
              setPortDraft(event.currentTarget.value);
              setPortError(false);
            }}
            onBlur={commitPort}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
            className="w-24 rounded-md border border-border/60 bg-background px-2 py-1 text-sm"
          />
        </SettingRow>
        <SettingRow
          label={t("ai.externalMcp.http.allowCustomBind")}
          description={t("ai.externalMcp.http.allowCustomBind.description")}
        >
          <Toggle
            checked={settings.allowCustomBind}
            onChange={(allowCustomBind) => onChange({ ...settings, allowCustomBind })}
            ariaLabel={t("ai.externalMcp.http.allowCustomBind")}
          />
        </SettingRow>
        {settings.allowCustomBind ? (
          <SettingRow label={t("ai.externalMcp.http.listenAddress")}>
            <input
              type="text"
              aria-label={t("ai.externalMcp.http.listenAddress")}
              aria-invalid={addressError}
              aria-describedby={addressError ? errorId : undefined}
              placeholder={t("ai.externalMcp.http.listenAddress.placeholder")}
              value={addressDraft}
              onChange={(event) => {
                setAddressDraft(event.currentTarget.value);
                setAddressError(false);
              }}
              onBlur={commitAddress}
              className="w-36 rounded-md border border-border/60 bg-background px-2 py-1 font-mono text-sm"
            />
          </SettingRow>
        ) : null}
        {showClientHost ? (
          <SettingRow
            label={t("ai.externalMcp.http.clientHost")}
            description={t("ai.externalMcp.http.clientHost.description")}
          >
            <input
              type="text"
              aria-label={t("ai.externalMcp.http.clientHost")}
              aria-invalid={clientHostError}
              aria-describedby={clientHostError ? errorId : undefined}
              placeholder={t("ai.externalMcp.http.clientHost.placeholder")}
              value={clientHostDraft}
              onChange={(event) => {
                setClientHostDraft(event.currentTarget.value);
                setClientHostError(false);
              }}
              onBlur={commitClientHost}
              className="w-36 rounded-md border border-border/60 bg-background px-2 py-1 font-mono text-sm"
            />
          </SettingRow>
        ) : null}
      </SettingCard>
      {settings.allowCustomBind ? (
        <p className="text-xs text-amber-500 leading-5">{t("ai.externalMcp.http.warning")}</p>
      ) : null}
      <p className="text-xs text-muted-foreground leading-5">{t("ai.externalMcp.http.wslHint")}</p>
      {settings.enabled && !externalMcpEnabled ? (
        <p className="text-xs text-amber-500">{t("ai.externalMcp.http.requiresExternalMcp")}</p>
      ) : null}
      {errorText ? <p id={errorId} role="alert" className="text-xs text-destructive">{errorText}</p> : null}
      <details className="space-y-4">
        <summary className="cursor-pointer text-sm font-medium">{t("ai.toolSettings.connectionDetails")}</summary>
        <CopyableCodeBlock
          label={t("ai.externalMcp.http.url")}
          value={url}
          copyKey="http-url"
          copied={copied}
          onCopy={onCopy}
          copyLabel={t("ai.externalMcp.copy")}
          copiedLabel={t("ai.externalMcp.copied")}
        />
        <CopyableCodeBlock
          label={t("ai.externalMcp.http.token")}
          value={token}
          sensitive
          copyKey="http-token"
          copied={copied}
          onCopy={onCopy}
          copyLabel={t("ai.externalMcp.copy")}
          copiedLabel={t("ai.externalMcp.copied")}
          emptyLabel={t("ai.externalMcp.unavailable")}
        />
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground leading-5">{t("ai.externalMcp.http.regenerateHint")}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!externalMcpEnabled || !settings.enabled || rotating}
            onClick={onRotateToken}
          >
            {t("ai.externalMcp.http.regenerate")}
          </Button>
        </div>
        <CopyableCodeBlock
          label={t("ai.externalMcp.http.codexSnippet")}
          value={buildCodexHttpToml(url)}
          copyKey="http-codex"
          copied={copied}
          onCopy={onCopy}
          copyLabel={t("ai.externalMcp.copy")}
          copiedLabel={t("ai.externalMcp.copied")}
        />
        <CopyableCodeBlock
          label={t("ai.externalMcp.http.envLine")}
          value={token ? buildCodexHttpEnvLine(token) : ""}
          sensitive
          copyKey="http-env"
          copied={copied}
          onCopy={onCopy}
          copyLabel={t("ai.externalMcp.copy")}
          copiedLabel={t("ai.externalMcp.copied")}
          emptyLabel={t("ai.externalMcp.unavailable")}
        />
        <CopyableCodeBlock
          label={t("ai.externalMcp.http.claudeCommand")}
          value={token ? buildClaudeHttpAddCommand(url, token) : ""}
          sensitive
          copyKey="http-claude"
          copied={copied}
          onCopy={onCopy}
          copyLabel={t("ai.externalMcp.copy")}
          copiedLabel={t("ai.externalMcp.copied")}
          emptyLabel={t("ai.externalMcp.unavailable")}
        />
        <CopyableCodeBlock
          label={t("ai.externalMcp.http.genericSnippet")}
          value={token ? buildGenericHttpMcpJson(url, token) : ""}
          sensitive
          copyKey="http-json"
          copied={copied}
          onCopy={onCopy}
          copyLabel={t("ai.externalMcp.copy")}
          copiedLabel={t("ai.externalMcp.copied")}
          emptyLabel={t("ai.externalMcp.unavailable")}
        />
      </details>
          </ToolSettingsDialog>
        </SettingRow>
      </SettingCard>
      {settings.enabled && !externalMcpEnabled ? <p className="text-xs text-amber-500">{t("ai.externalMcp.http.requiresExternalMcp")}</p> : null}
      {status?.error ? <p role="alert" className="text-xs text-destructive">{status.error}</p> : null}
    </SettingsAnchor>
  );
};
