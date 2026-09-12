import React, { useState } from "react";
import { Check, Copy } from "lucide-react";
import { useI18n } from "../../../../application/i18n/I18nProvider";
import type { AIToolIntegrationMode } from "../../../../infrastructure/ai/types";
import { cn } from "../../../../lib/utils";
import { useToolAccessGuidanceState } from "../../../../application/state/useToolAccessGuidanceState";
import { EXTERNAL_MCP_DISCOVERY_ENV_VAR } from "./ExternalMcpCard";

/** Build a ready-to-paste prompt so an external AI client can register Netcatty MCP itself. */
export function buildMcpOnboardingPrompt(
  launcherPath: string | null | undefined,
  discoveryPath: string | null | undefined,
): string {
  if (!launcherPath) {
    return [
      "Please connect Netcatty to this session via MCP.",
      "In the Netcatty desktop app, open Settings → AI → Tool Access, turn on External MCP,",
      "then copy the generated prompt from the Tool Access section and run it here.",
      "After that, list the netcatty-external MCP tools and call get_environment to verify the connection.",
    ].join(" ");
  }
  const lines = [
    "Please register Netcatty's MCP server in your MCP client configuration:",
    `- Server name: netcatty-external`,
    `- Transport: local stdio`,
    `- Command: ${launcherPath}`,
  ];
  if (discoveryPath) {
    lines.push(`- Environment: ${EXTERNAL_MCP_DISCOVERY_ENV_VAR}=${discoveryPath}`);
  }
  lines.push(
    "After registering, list the server's tools and call get_environment to verify the connection.",
    "Keep the Netcatty desktop app running while you use these tools.",
  );
  return lines.join("\n");
}

type CopyRowProps = {
  value: string;
  label: string;
  copyLabel: string;
  copiedLabel: string;
  testId?: string;
};

const CopyRow: React.FC<CopyRowProps> = ({ value, label, copyLabel, copiedLabel, testId }) => {
  const [copied, setCopied] = useState(false);
  const canCopy = Boolean(value);

  const handleCopy = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard may be unavailable; the text stays selectable in the block.
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="group relative rounded-md border border-border/60 bg-muted/20">
        <pre
          data-testid={testId}
          className={cn(
            "max-h-40 overflow-auto whitespace-pre-wrap break-all px-3 py-2.5 pr-11 font-mono text-xs leading-5",
            !value && "text-muted-foreground",
          )}
        >
          {value}
        </pre>
        <button
          type="button"
          disabled={!canCopy}
          className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40"
          onClick={() => void handleCopy()}
          aria-label={copied ? copiedLabel : copyLabel}
          title={copied ? copiedLabel : copyLabel}
        >
          {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
        </button>
      </div>
    </div>
  );
};

export const ToolAccessGuidance: React.FC<{ mode: AIToolIntegrationMode }> = ({ mode }) => {
  const { t } = useI18n();
  const { skillPath, commandPrefix, mcpLauncherPath, mcpDiscoveryPath } =
    useToolAccessGuidanceState(mode);

  if (mode === "skills") {
    return (
      <div className="rounded-md border border-border/60 bg-background/50 p-3 space-y-2">
        <p className="text-xs text-muted-foreground leading-5">
          {t("ai.toolAccess.skills.description")}
        </p>
        <CopyRow
          value={skillPath || ""}
          label={t("ai.toolAccess.skills.file")}
          copyLabel={t("ai.externalMcp.copy")}
          copiedLabel={t("ai.externalMcp.copied")}
          testId="tool-access-skill-path"
        />
        {!skillPath ? (
          <p className="text-xs text-amber-500">{t("ai.toolAccess.skills.unavailable")}</p>
        ) : null}
        {commandPrefix ? (
          <p className="text-xs text-muted-foreground/80 font-mono break-all">{commandPrefix}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border/60 bg-background/50 p-3 space-y-2">
      <p className="text-xs text-muted-foreground leading-5">
        {t("ai.toolAccess.mcpPrompt.description")}
      </p>
      <CopyRow
        value={buildMcpOnboardingPrompt(mcpLauncherPath, mcpDiscoveryPath)}
        label={t("ai.toolAccess.mcpPrompt.title")}
        copyLabel={t("ai.externalMcp.copy")}
        copiedLabel={t("ai.externalMcp.copied")}
        testId="tool-access-mcp-prompt"
      />
      {!mcpLauncherPath ? (
        <p className="text-xs text-amber-500">{t("ai.toolAccess.mcpPrompt.enableHint")}</p>
      ) : null}
    </div>
  );
};
