import React from "react";

import { useI18n } from "../../application/i18n/I18nProvider";
import type { Host } from "../../domain/models";
import {
  hasCompanionRdp,
  hasCompanionVnc,
  isRdpProtocol,
  isVncProtocol,
  type RemoteDesktopProtocol,
} from "../../domain/remoteDesktop";
import { RdpProtocolIcon, VncProtocolIcon } from "../icons/RemoteDesktopIcons";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

export interface HostRemoteDesktopIndicatorsProps {
  host: Host;
  size?: number;
  onConnectRemoteDesktop?: (host: Host, protocol: RemoteDesktopProtocol) => void;
}

export const HostRemoteDesktopIndicators: React.FC<HostRemoteDesktopIndicatorsProps> = ({
  host,
  size = 14,
  onConnectRemoteDesktop,
}) => {
  const { t } = useI18n();
  const isStandaloneRdp = isRdpProtocol(host.protocol);
  const isStandaloneVnc = isVncProtocol(host.protocol);
  const companionRdp = !isStandaloneRdp && hasCompanionRdp(host);
  const companionVnc = !isStandaloneVnc && hasCompanionVnc(host);

  if (!isStandaloneRdp && !isStandaloneVnc && !companionRdp && !companionVnc) {
    return null;
  }

  const renderIndicator = (
    key: string,
    protocol: RemoteDesktopProtocol,
    tooltipText: string,
    clickable: boolean,
  ) => {
    const isRdp = protocol === "rdp";
    const colorClass = isRdp
      ? "text-blue-500 dark:text-blue-400"
      : "text-teal-500 dark:text-teal-400";
    const hoverClass = isRdp
      ? "hover:text-blue-600 dark:hover:text-blue-300"
      : "hover:text-teal-600 dark:hover:text-teal-300";
    const icon = isRdp ? <RdpProtocolIcon size={size} aria-hidden /> : <VncProtocolIcon size={size} aria-hidden />;

    return (
      <Tooltip key={key} delayDuration={180}>
        <TooltipTrigger asChild>
          {clickable && onConnectRemoteDesktop ? (
            <button
              type="button"
              aria-label={tooltipText}
              className={`inline-flex shrink-0 items-center justify-center border-0 bg-transparent p-0 transition-colors cursor-pointer ${colorClass} ${hoverClass}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onConnectRemoteDesktop(host, protocol);
              }}
            >
              {icon}
            </button>
          ) : (
            <span
              aria-label={tooltipText}
              className={`inline-flex shrink-0 items-center justify-center border-0 bg-transparent p-0 ${colorClass}`}
            >
              {icon}
            </span>
          )}
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {tooltipText}
        </TooltipContent>
      </Tooltip>
    );
  };

  return (
    <>
      {isStandaloneRdp && renderIndicator("rdp", "rdp", "RDP", false)}
      {isStandaloneVnc && renderIndicator("vnc", "vnc", "VNC", false)}
      {companionRdp && renderIndicator("companion-rdp", "rdp", t("vault.hosts.connectRdp"), true)}
      {companionVnc && renderIndicator("companion-vnc", "vnc", t("vault.hosts.connectVnc"), true)}
    </>
  );
};
