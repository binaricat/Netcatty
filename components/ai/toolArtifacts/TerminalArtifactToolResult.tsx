import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip';
import { formatTerminalToolTooltip } from './formatTerminalToolTooltip';
import { TerminalArtifactCard } from './TerminalArtifactCard';
import type { TerminalToolArtifact } from './terminalToolArtifact';

interface TerminalArtifactToolResultProps {
  artifact: TerminalToolArtifact;
  toolName: string;
  args?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
}

export const TerminalArtifactToolResult: React.FC<TerminalArtifactToolResultProps> = ({
  artifact,
  toolName,
  args,
  result,
  isError,
}) => {
  const tooltip = formatTerminalToolTooltip(toolName, args, result, isError);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <TerminalArtifactCard artifact={artifact} />
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
