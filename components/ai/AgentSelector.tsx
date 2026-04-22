/**
 * AgentSelector - Dropdown for switching between AI agents
 *
 * Dark, grouped agent menu with local SVG branding for built-in,
 * discovered, and external agents.
 */

import { ChevronDown, RefreshCw, Plus, Settings } from 'lucide-react';
import React, { useCallback, useMemo, useState } from 'react';
import { cn } from '../../lib/utils';
import { useI18n } from '../../application/i18n/I18nProvider';
import {
  isSettingsManagedDiscoveredAgent,
  matchesManagedAgentConfig,
} from '../../infrastructure/ai/managedAgents';
import type { AgentInfo, ExternalAgentConfig, DiscoveredAgent } from '../../infrastructure/ai/types';
import AgentIconBadge from './AgentIconBadge';
import {
  Dropdown,
  DropdownContent,
  DropdownTrigger,
} from '../ui/dropdown';

interface AgentSelectorProps {
  currentAgentId: string;
  externalAgents: ExternalAgentConfig[];
  discoveredAgents?: DiscoveredAgent[];
  isDiscovering?: boolean;
  onSelectAgent: (agentId: string) => void;
  onEnableDiscoveredAgent?: (agent: DiscoveredAgent) => void;
  onRediscover?: () => void;
  onManageAgents?: () => void;
}

const BUILTIN_AGENTS: AgentInfo[] = [
  {
    id: 'catty',
    name: 'Catty Agent',
    type: 'builtin',
    description: 'Built-in terminal assistant',
    available: true,
  },
];

const SectionLabel: React.FC<{ children: React.ReactNode; action?: React.ReactNode }> = ({ children, action }) => (
  <div className="px-4 pb-2 pt-2 flex items-center justify-between">
    <span className="text-[10px] font-medium tracking-wide text-muted-foreground/52">
      {children}
    </span>
    {action}
  </div>
);

const AgentMenuRow: React.FC<{
  agent: AgentInfo;
  isActive?: boolean;
  subtitle?: string;
  onClick: () => void;
}> = ({ agent, isActive, subtitle, onClick }) => {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex h-10 w-full items-center gap-3 px-4 text-left text-[13px] text-foreground/86 transition-colors cursor-pointer hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/30',
        isActive && 'bg-muted',
      )}
    >
      <AgentIconBadge agent={agent} size="xs" variant="plain" className="opacity-78" />
      <div className="min-w-0 flex-1">
        <span className="block truncate">{agent.name}</span>
        {subtitle && (
          <span className="block truncate text-[10px] text-muted-foreground/40">{subtitle}</span>
        )}
      </div>
    </button>
  );
};

const DiscoveredAgentRow: React.FC<{
  agent: DiscoveredAgent;
  onEnable: () => void;
}> = ({ agent, onEnable }) => {
  const agentLike: AgentInfo = {
    id: `discovered_${agent.command}`,
    name: agent.name,
    type: 'external',
    icon: agent.icon,
    command: agent.command,
    available: true,
  };

  return (
    <div className="flex h-10 w-full items-center gap-3 rounded-md px-4 text-[13px]">
      <AgentIconBadge agent={agentLike} size="xs" variant="plain" className="opacity-78" />
      <div className="min-w-0 flex-1">
        <span className="block truncate text-foreground/86">{agent.name}</span>
        <span className="block truncate text-[10px] text-muted-foreground/40">
          {agent.version || agent.path}
        </span>
      </div>
      <button
        onClick={onEnable}
        className="shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium text-primary/80 hover:bg-primary/10 hover:text-primary transition-colors cursor-pointer"
        title={`Enable ${agent.name}`}
      >
        <Plus size={12} />
      </button>
    </div>
  );
};

const AgentSelector: React.FC<AgentSelectorProps> = ({
  currentAgentId,
  externalAgents,
  discoveredAgents = [],
  isDiscovering = false,
  onSelectAgent,
  onEnableDiscoveredAgent,
  onRediscover,
  onManageAgents,
}) => {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  const enabledExternalAgents = useMemo(
    () =>
      externalAgents
        .filter((agent) => agent.enabled)
        .map(
          (agent): AgentInfo => ({
            id: agent.id,
            name: agent.name,
            type: 'external',
            icon: agent.icon,
            command: agent.command,
            args: agent.args,
            available: true,
          }),
        ),
    [externalAgents],
  );

  // Discovered agents not yet added to external agents
  const unconfiguredDiscovered = useMemo(
    () =>
      discoveredAgents.filter(
        (da) => {
          if (isSettingsManagedDiscoveredAgent(da)) {
            return !externalAgents.some((ea) => matchesManagedAgentConfig(ea, da.command));
          }
          return !externalAgents.some((ea) => ea.command === da.command || ea.command === da.path);
        },
      ),
    [discoveredAgents, externalAgents],
  );

  const allAgents = useMemo(
    () => [...BUILTIN_AGENTS, ...enabledExternalAgents],
    [enabledExternalAgents],
  );

  const currentAgent = useMemo(
    () => allAgents.find((agent) => agent.id === currentAgentId) ?? BUILTIN_AGENTS[0],
    [allAgents, currentAgentId],
  );

  const handleSelect = useCallback(
    (agentId: string) => {
      onSelectAgent(agentId);
      setOpen(false);
    },
    [onSelectAgent],
  );

  const handleEnableDiscovered = useCallback(
    (agent: DiscoveredAgent) => {
      onEnableDiscoveredAgent?.(agent);
      // After enabling, auto-select it
      const agentId = `discovered_${agent.command}`;
      onSelectAgent(agentId);
      setOpen(false);
    },
    [onEnableDiscoveredAgent, onSelectAgent],
  );

  const handleManageAgents = useCallback(() => {
    setOpen(false);
    onManageAgents?.();
  }, [onManageAgents]);

  return (
    <Dropdown open={open} onOpenChange={setOpen}>
      <DropdownTrigger asChild>
        <button
          type="button"
          className="group flex h-8 min-w-0 max-w-[170px] items-center gap-2 rounded-md px-2 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/28"
        >
          <AgentIconBadge
            agent={currentAgent}
            size="xs"
            variant="plain"
            className="opacity-78"
          />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground/90">
            {currentAgent.name}
          </span>
          <ChevronDown
            size={12}
            className={cn(
              'shrink-0 text-muted-foreground/60 transition-transform',
              open && 'rotate-180',
            )}
          />
        </button>
      </DropdownTrigger>

      <DropdownContent
        align="start"
        sideOffset={6}
        className="w-[288px] overflow-hidden rounded-2xl border border-border/50 bg-popover p-0 text-foreground shadow-lg supports-[backdrop-filter]:backdrop-blur-sm"
      >
        {BUILTIN_AGENTS.map((agent) => (
          <AgentMenuRow
            key={agent.id}
            agent={agent}
            isActive={currentAgentId === agent.id}
            onClick={() => handleSelect(agent.id)}
          />
        ))}

        {enabledExternalAgents.length > 0 && (
          <>
            <div className="mx-0 my-1 border-t border-border/50" />
            <SectionLabel>{t('ai.chat.agents')}</SectionLabel>
            {enabledExternalAgents.map((agent) => (
              <AgentMenuRow
                key={agent.id}
                agent={agent}
                isActive={currentAgentId === agent.id}
                subtitle={agent.command}
                onClick={() => handleSelect(agent.id)}
              />
            ))}
          </>
        )}

        {unconfiguredDiscovered.length > 0 && (
          <>
            <div className="mx-0 my-1 border-t border-border/50" />
            <SectionLabel
              action={
                onRediscover && (
                  <button
                    onClick={onRediscover}
                    disabled={isDiscovering}
                    className="text-[10px] text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors cursor-pointer disabled:opacity-50"
                    title={t('ai.chat.rescan')}
                  >
                    <RefreshCw size={10} className={cn(isDiscovering && 'animate-spin')} />
                  </button>
                )
              }
            >
              {t('ai.chat.detectedOnMachine')}
            </SectionLabel>
            {unconfiguredDiscovered.map((agent) => (
              <DiscoveredAgentRow
                key={agent.command}
                agent={agent}
                onEnable={() => handleEnableDiscovered(agent)}
              />
            ))}
          </>
        )}

        <div className="mx-0 my-1 border-t border-border/50" />
        <button
          onClick={handleManageAgents}
          className="flex h-10 w-full items-center gap-3 px-4 text-left text-[13px] text-foreground/82 transition-colors cursor-pointer hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/30"
        >
          <Settings size={16} className="opacity-72 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{t('ai.agentSettings')}</span>
        </button>
      </DropdownContent>
    </Dropdown>
  );
};

export default React.memo(AgentSelector);
