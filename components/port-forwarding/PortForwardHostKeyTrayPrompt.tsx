import React from "react";
import type { KnownHost } from "../../domain/models";
import { usePortForwardHostKeyVerification } from "../../application/state/usePortForwardHostKeyVerification";
import { useI18n } from "../../application/i18n/I18nProvider";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

interface PortForwardHostKeyTrayPromptProps {
  onAddKnownHost?: (knownHost: KnownHost) => void;
}

export const PortForwardHostKeyTrayPrompt: React.FC<PortForwardHostKeyTrayPromptProps> = ({
  onAddKnownHost,
}) => {
  const { t } = useI18n();
  const {
    hostKeyVerification,
    rejectHostKeyVerification,
    acceptHostKeyVerification,
    acceptAndSaveHostKeyVerification,
  } = usePortForwardHostKeyVerification(onAddKnownHost);

  if (!hostKeyVerification) return null;

  const { hostKeyInfo } = hostKeyVerification;
  const isChanged = hostKeyInfo.status === "changed";

  return (
    <div
      data-port-forward-host-key-tray-prompt="true"
      className={cn(
        "px-3 py-2",
        isChanged ? "bg-destructive/8" : "bg-muted/45",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              "truncate text-xs font-semibold",
              isChanged ? "text-destructive" : "text-foreground",
            )}
          >
            {isChanged
              ? t("terminal.hostKey.changedTitle")
              : t("terminal.hostKey.unknownTitle")}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {hostKeyInfo.hostname}:{hostKeyInfo.port}
          </div>
        </div>
      </div>

      <div className="mt-1.5 text-[10px] leading-4 text-muted-foreground">
        {t("terminal.hostKey.fingerprintLabel", { keyType: hostKeyInfo.keyType })}
        <code className="ml-1 break-all font-mono text-[11px] text-foreground/90">
          {hostKeyInfo.fingerprint}
        </code>
      </div>

      {isChanged && hostKeyInfo.knownFingerprint && (
        <div className="mt-1.5 text-[10px] leading-4 text-muted-foreground">
          <span className="font-medium text-destructive">
            {t("terminal.hostKey.savedFingerprintLabel")}
          </span>
          <code className="ml-1 break-all font-mono text-[11px] text-foreground/90">
            {hostKeyInfo.knownFingerprint}
          </code>
        </div>
      )}

      <div className="mt-2 grid grid-cols-[auto_auto_1fr] gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-[10px]"
          onClick={rejectHostKeyVerification}
        >
          {t("common.close")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-1.5 text-[10px]"
          onClick={acceptHostKeyVerification}
        >
          {t("common.continue")}
        </Button>
        <Button
          size="sm"
          className="h-6 min-w-0 px-1.5 text-[10px]"
          onClick={acceptAndSaveHostKeyVerification}
        >
          <span className="truncate">
            {isChanged
              ? t("terminal.hostKey.updateAndContinue")
              : t("terminal.hostKey.addAndContinue")}
          </span>
        </Button>
      </div>
    </div>
  );
};
