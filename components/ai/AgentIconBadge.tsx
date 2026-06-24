import React from 'react';
import { cn } from '../../lib/utils';
import {
  AGENT_ICON_VISUALS,
  resolveAgentIconKey,
  type AgentIconKey,
  type AgentIconSource,
} from '../../domain/agentIcon';

export type { AgentIconKey, AgentIconSource };

export const AgentIconBadge: React.FC<{
  agent: AgentIconSource | 'add-more';
  size?: 'xs' | 'sm' | 'md' | 'lg';
  variant?: 'plain' | 'badge';
  className?: string;
}> = ({ agent, size = 'md', variant = 'badge', className }) => {
  const iconKey = resolveAgentIconKey(agent);
  const visual = AGENT_ICON_VISUALS[iconKey];
  const badgeSize =
    size === 'xs'
      ? 'h-4 w-4 rounded-sm'
      : size === 'sm'
        ? 'h-7 w-7 rounded-lg'
        : size === 'lg'
          ? 'h-10 w-10 rounded-xl'
          : 'h-8 w-8 rounded-lg';
  const imageSize =
    size === 'xs'
      ? 'h-3.5 w-3.5'
      : size === 'sm'
        ? 'h-3.5 w-3.5'
        : size === 'lg'
          ? 'h-5 w-5'
          : 'h-4 w-4';

  if (variant === 'plain') {
    return (
      <div
        aria-hidden="true"
        className={cn('shrink-0', imageSize, className)}
        style={{
          maskImage: `url(${visual.src})`,
          WebkitMaskImage: `url(${visual.src})`,
          maskSize: 'contain',
          WebkitMaskSize: 'contain',
          maskRepeat: 'no-repeat',
          WebkitMaskRepeat: 'no-repeat',
          maskPosition: 'center',
          WebkitMaskPosition: 'center',
          backgroundColor: 'currentColor',
        }}
      />
    );
  }

  return (
    <div
      data-agent-badge=""
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden border',
        badgeSize,
        visual.badgeClassName,
        className,
      )}
    >
      <img
        src={visual.src}
        alt=""
        aria-hidden="true"
        draggable={false}
        className={cn(imageSize, visual.imageClassName)}
      />
    </div>
  );
};

export default AgentIconBadge;
