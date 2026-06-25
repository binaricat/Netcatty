import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip';
import { VaultArtifactCard } from './VaultArtifactCard';
import { formatVaultToolTooltip } from './formatVaultToolTooltip';
import type { VaultToolArtifact } from './vaultToolArtifact';

interface VaultArtifactToolResultProps {
  artifact: VaultToolArtifact;
  toolName: string;
  args?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
}

export const VaultArtifactToolResult: React.FC<VaultArtifactToolResultProps> = ({
  artifact,
  toolName,
  args,
  result,
  isError,
}) => {
  const tooltip = formatVaultToolTooltip(toolName, args, result, isError);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <VaultArtifactCard artifact={artifact} toolName={toolName} className="cursor-pointer" />
      </TooltipTrigger>
      <TooltipContent
        side="top"
        align="start"
        className="max-w-md whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed"
      >
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
};
