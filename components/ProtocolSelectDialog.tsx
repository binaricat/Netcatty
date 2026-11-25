import { Plug } from "lucide-react";
import React, { useMemo, useState } from "react";
import { useI18n } from "../application/i18n/I18nProvider";
import { formatHostPort } from "../domain/host";
import { isPluginHostProtocol } from "../domain/pluginConnection";
import { cn } from "../lib/utils";
import { Host, HostProtocol } from "../types";
import {
  getProtocolOptionCardClass,
  getProtocolVisualStyle,
  PROTOCOL_OPTION_SUBTITLE_IDLE_CLASS,
  PROTOCOL_OPTION_SUBTITLE_SELECTED_CLASS,
  PROTOCOL_OPTION_TITLE_IDLE_CLASS,
  PROTOCOL_OPTION_TITLE_SELECTED_CLASS,
  type ProtocolVisualKey,
} from "./protocolVisuals";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

interface ProtocolOption {
  protocol: HostProtocol;
  port: number;
  label: string;
  description: string;
  enabled: boolean;
}

interface ProtocolSelectDialogProps {
  host: Host;
  onSelect: (protocol: HostProtocol, port: number) => void;
  onCancel: () => void;
}

const ProtocolSelectDialog: React.FC<ProtocolSelectDialogProps> = ({
  host,
  onSelect,
  onCancel,
}) => {
  const { t } = useI18n();

  const protocolOptions = useMemo<ProtocolOption[]>(() => {
    const options: ProtocolOption[] = [];
    const pluginOption = isPluginHostProtocol(host.protocol) && host.pluginConnection
      ? {
        protocol: host.protocol,
        port: host.port || 22,
        label: host.pluginConnection.providerId,
        description: host.pluginConnection.providerId,
        enabled: true,
      } satisfies ProtocolOption
      : null;

    if (pluginOption) options.push(pluginOption);

    const sshEnabled =
      host.protocol === "ssh" ||
      !host.protocol ||
      host.protocols?.some((p) => p.protocol === "ssh" && p.enabled);
    if (sshEnabled !== false) {
      const sshConfig = host.protocols?.find((p) => p.protocol === "ssh");
      options.push({
        protocol: "ssh",
        port: sshConfig?.port || host.port || 22,
        label: "SSH",
        description: `ssh ${host.hostname}`,
        enabled: true,
      });
    }

    if (host.moshEnabled || host.protocols?.some((p) => p.protocol === "mosh" && p.enabled)) {
      const moshConfig = host.protocols?.find((p) => p.protocol === "mosh");
      options.push({
        protocol: "mosh",
        port: moshConfig?.port || host.port || 22,
        label: "Mosh",
        description: `mosh ${host.hostname}`,
        enabled: true,
      });
    }

    if (host.etEnabled || host.protocols?.some((p) => p.protocol === "et" && p.enabled)) {
      options.push({
        protocol: "et",
        port: host.port || 22,
        label: "EternalTerminal",
        description: `et ${host.hostname}`,
        enabled: true,
      });
    }

    if (
      host.telnetEnabled ||
      host.protocol === "telnet" ||
      host.protocols?.some((p) => p.protocol === "telnet" && p.enabled)
    ) {
      const telnetConfig = host.protocols?.find((p) => p.protocol === "telnet");
      options.push({
        protocol: "telnet",
        port: telnetConfig?.port || host.telnetPort || 23,
        label: "Telnet",
        description: `telnet ${host.hostname}`,
        enabled: true,
      });
    }

    return options;
  }, [host]);

  const [ports, setPorts] = useState<Record<HostProtocol, number>>(() => {
    const initial: Record<string, number> = {};
    protocolOptions.forEach((opt) => {
      initial[opt.protocol] = opt.port;
    });
    return initial as Record<HostProtocol, number>;
  });

  const [selectedProtocol, setSelectedProtocol] = useState<HostProtocol>(
    protocolOptions[0]?.protocol || "ssh",
  );

  const handlePortChange = (protocol: HostProtocol, value: string) => {
    const port = parseInt(value, 10);
    if (!isNaN(port) && port > 0 && port <= 65535) {
      setPorts((prev) => ({ ...prev, [protocol]: port }));
    }
  };

  const handleContinue = () => {
    onSelect(selectedProtocol, ports[selectedProtocol] || 22);
  };

  const hostEndpoint = isPluginHostProtocol(selectedProtocol)
    ? host.hostname
    : formatHostPort(
      host.hostname,
      ports[selectedProtocol] || host.port || 22,
    );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onCancel}>
      <div
        className="w-[560px] max-w-[90vw] bg-background border border-border rounded-2xl animate-in fade-in-0 zoom-in-95 duration-200"
        style={{
          boxShadow:
            "0 25px 50px -12px rgba(0, 0, 0, 0.25), 0 12px 24px -8px rgba(0, 0, 0, 0.15)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-border/50">
          <div className="flex items-center gap-2 min-w-0">
            <Plug size={18} className="shrink-0 text-foreground" />
            <div className="min-w-0">
              <h2 className="text-base font-semibold truncate">
                {t("quickConnect.connectTitle", {
                  host: host.label?.trim() || host.hostname,
                })}
              </h2>
              <p className="text-xs text-muted-foreground font-mono truncate">{hostEndpoint}</p>
            </div>
          </div>
        </div>

        <div className="px-6 py-4">
          <div className="space-y-4">
            <h3 className="text-sm font-medium">{t("protocolSelect.chooseProtocol")}</h3>
            <div className="space-y-3">
              {protocolOptions.map((option) => {
                const isSelected = selectedProtocol === option.protocol;
                const visual = isPluginHostProtocol(option.protocol)
                  ? {
                    icon: <Plug size={18} />,
                    selected: "bg-primary text-primary-foreground shadow-sm",
                    idle: "bg-secondary text-muted-foreground",
                  }
                  : getProtocolVisualStyle(option.protocol as ProtocolVisualKey);
                return (
                  <button
                    key={option.protocol}
                    type="button"
                    aria-pressed={isSelected}
                    data-state={isSelected ? "active" : "inactive"}
                    data-protocol={option.protocol}
                    className={getProtocolOptionCardClass(isSelected)}
                    onClick={() => setSelectedProtocol(option.protocol)}
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className={cn(
                          "h-10 w-10 rounded-lg flex items-center justify-center transition-colors",
                          isSelected ? visual.selected : visual.idle,
                        )}
                      >
                        {visual.icon}
                      </div>
                      <div>
                        <div
                          className={
                            isSelected
                              ? PROTOCOL_OPTION_TITLE_SELECTED_CLASS
                              : PROTOCOL_OPTION_TITLE_IDLE_CLASS
                          }
                        >
                          {option.label}
                        </div>
                        <div
                          className={
                            isSelected
                              ? PROTOCOL_OPTION_SUBTITLE_SELECTED_CLASS
                              : PROTOCOL_OPTION_SUBTITLE_IDLE_CLASS
                          }
                        >
                          {option.description}
                        </div>
                      </div>
                    </div>
                    {!isPluginHostProtocol(option.protocol) && (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">{t("protocolSelect.port")}</span>
                        <Input
                          type="number"
                          value={ports[option.protocol] || option.port}
                          onChange={(e) => handlePortChange(option.protocol, e.target.value)}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedProtocol(option.protocol);
                          }}
                          className="w-16 h-7 text-xs text-center"
                          min={1}
                          max={65535}
                        />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-border/50 flex items-center justify-between">
          <Button variant="secondary" onClick={onCancel}>
            {t("common.close")}
          </Button>
          <Button onClick={handleContinue}>{t("common.continue")}</Button>
        </div>
      </div>
    </div>
  );
};

export default ProtocolSelectDialog;
