import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip';
import { formatRemoteDesktopToolTooltip } from './formatRemoteDesktopToolTooltip';
import { RemoteDesktopArtifactCard } from './RemoteDesktopArtifactCard';
import type { RemoteDesktopToolArtifact } from './remoteDesktopToolArtifact';

interface RemoteDesktopArtifactToolResultProps {
  artifact: RemoteDesktopToolArtifact;
  toolName: string;
  args?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
  onOpenImagePreview?: (src: string, name: string) => void;
}

export const RemoteDesktopArtifactToolResult: React.FC<RemoteDesktopArtifactToolResultProps> = ({
  artifact,
  toolName,
  args,
  result,
  isError,
  onOpenImagePreview,
}) => {
  const tooltip = formatRemoteDesktopToolTooltip(toolName, args, result, isError);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <RemoteDesktopArtifactCard
          artifact={artifact}
          onOpenImagePreview={onOpenImagePreview}
        />
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
