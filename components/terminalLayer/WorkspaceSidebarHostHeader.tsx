import React, { memo } from 'react';

import { formatHostPort } from '../../domain/host';
import type { Host } from '../../types';
import { DistroAvatar } from '../DistroAvatar';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

interface WorkspaceSidebarHostHeaderProps {
  host: Host;
  section?: string;
}

export const WorkspaceSidebarHostHeader = memo(function WorkspaceSidebarHostHeader({
  host,
  section = 'terminal-sidebar-host-header',
}: WorkspaceSidebarHostHeaderProps) {
  const username = host.username || 'root';
  const port = host.port || 22;

  return (
    <div
      className="shrink-0 border-b border-border/50 bg-muted/20 px-3 py-1.5"
      data-section={section}
    >
      <div className="flex items-center gap-2 min-w-0">
        <DistroAvatar
          host={host}
          fallback={host.label.slice(0, 2).toUpperCase()}
          size="sm"
          className="h-5 w-5 rounded-sm shrink-0"
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="min-w-0 flex-1 max-w-[calc(100%-1.75rem)] text-[11px] leading-5 truncate cursor-default">
              <span className="font-medium">{host.label}</span>
              <span className="mx-1 text-muted-foreground">·</span>
              <span className="font-mono text-muted-foreground">
                {username}@{host.hostname}:{port}
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent>
            {`${host.label} · ${username}@${formatHostPort(host.hostname, port)}`}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
});
