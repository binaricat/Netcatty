import { ArrowRightLeft, Network, Skull, Square } from 'lucide-react';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import {
  useQuickPortForwarding,
  type QuickPortForwardingContext,
} from '../../application/state/useQuickPortForwarding';
import type { useSystemManagerBackend } from '../../application/state/useSystemManagerBackend';
import { usePolling, useStableTranslate } from '../../application/state/useSystemManager';
import type { PortForwardingRule } from '../../domain/models';
import { listeningPortInfoEqual } from '../../domain/systemManager/pollEquals';
import {
  DEFAULT_QUICK_FORWARD_BIND_ADDRESS,
  formatCopyableLocalEndpoint,
  formatHostPort,
  isForwardableListeningPort,
  matchListeningPortForwardRules,
  resolveForwardRemoteHost,
  suggestQuickForwardLocalPort,
} from '../../domain/systemManager/portForwardQuick';
import type { ListeningPortInfo } from '../../domain/systemManager/types';
import { toast } from '../ui/toast';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { QuickPortForwardDialog } from './QuickPortForwardDialog';
import { SystemPanelConfirmDialog } from './SystemPanelConfirmDialog';
import { mergePollListByKey, useStableListOrder } from './listStable';
import {
  SystemPanelEmpty,
  SystemPanelError,
  SystemPanelInlineError,
  SystemPanelList,
  SystemPanelLoading,
  SystemPanelMetaBar,
  SystemPanelRefreshButton,
  SystemPanelRoundButton,
  SystemPanelRow,
  SystemPanelSearch,
  SystemPanelSegmented,
  SystemPanelShell,
  SystemPanelStatusBadge,
  SystemPanelToolbar,
} from './SystemPanelUi';

type Backend = ReturnType<typeof useSystemManagerBackend>;
type PortFilter = 'all' | 'tcp' | 'udp';

const mergePorts = (
  prev: ListeningPortInfo[] | null,
  next: ListeningPortInfo[],
) => mergePollListByKey(prev, next, (p) => p.id, listeningPortInfoEqual);

interface PortsManagerTabProps {
  sessionId: string;
  isVisible: boolean;
  backend: Backend;
  refreshIntervalSec: number;
  /** Network appliances: list only, no process terminate. */
  allowMutations?: boolean;
  /** Optional host/auth context enabling one-click SSH local port forwarding. */
  portForwardingContext?: QuickPortForwardingContext;
}

export const PortsManagerTab = memo(function PortsManagerTab({
  sessionId,
  isVisible,
  backend,
  refreshIntervalSec,
  allowMutations = true,
  portForwardingContext,
}: PortsManagerTabProps) {
  const { t } = useI18n();
  const stableT = useStableTranslate();
  const intervalMs = Math.max(2, refreshIntervalSec) * 1000;
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<PortFilter>('all');
  const [pendingKillPid, setPendingKillPid] = useState<number | null>(null);
  const [killBusy, setKillBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [listPending, setListPending] = useState(false);
  const [forwardDialogPort, setForwardDialogPort] = useState<ListeningPortInfo | null>(null);
  const [forwardDialogInitialPort, setForwardDialogInitialPort] = useState<number>(8080);
  const [forwardDialogInitialBind, setForwardDialogInitialBind] = useState<string>(DEFAULT_QUICK_FORWARD_BIND_ADDRESS);
  const [forwardBusy, setForwardBusy] = useState(false);
  const [forwardError, setForwardError] = useState<string | null>(null);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const quickForward = useQuickPortForwarding(portForwardingContext);

  useEffect(() => {
    setListPending(false);
    setPendingKillPid(null);
    setKillBusy(false);
    setActionError(null);
    setForwardDialogPort(null);
    setForwardBusy(false);
    setForwardError(null);
  }, [sessionId]);

  const fetcher = useCallback(async (): Promise<ListeningPortInfo[] | null> => {
    const requestedSessionId = sessionId;
    try {
      const result = await backend.listListeningPorts(requestedSessionId);
      if (sessionIdRef.current !== requestedSessionId) return null;
      if (result.pending) {
        setListPending(true);
        return null;
      }
      setListPending(false);
      if (!result.success) {
        throw new Error(result.error || stableT('systemManager.errors.loadPorts'));
      }
      return result.ports || [];
    } catch (error) {
      if (sessionIdRef.current === requestedSessionId) setListPending(false);
      throw error;
    }
  }, [backend, sessionId, stableT]);

  const { data, error, loading, refresh } = usePolling(
    fetcher,
    intervalMs,
    isVisible,
    mergePorts,
    { resetKey: sessionId },
  );

  const isRefreshActive = loading || listPending;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data || []).filter((port) => {
      if (filter === 'tcp' && !port.protocol.startsWith('tcp')) return false;
      if (filter === 'udp' && !port.protocol.startsWith('udp')) return false;
      if (!q) return true;
      return (
        String(port.port).includes(q)
        || port.address.toLowerCase().includes(q)
        || port.processName.toLowerCase().includes(q)
        || (port.pid != null && String(port.pid).includes(q))
        || port.protocol.toLowerCase().includes(q)
      );
    });
  }, [data, filter, query]);

  const ports = useStableListOrder(
    filtered,
    (p) => p.id,
    `${filter}|${query}`,
    (a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol),
  );

  const portMatchesById = useMemo(() => {
    const map = new Map<string, ReturnType<typeof matchListeningPortForwardRules>>();
    if (!quickForward.canForward || !quickForward.hostId) return map;
    for (const port of ports) {
      map.set(
        port.id,
        matchListeningPortForwardRules(port, quickForward.hostId, quickForward.allRules),
      );
    }
    return map;
  }, [ports, quickForward.allRules, quickForward.canForward, quickForward.hostId]);

  const activeForwardCount = useMemo(() => {
    const uniqueRuleIds = new Set<string>();
    for (const matches of portMatchesById.values()) {
      for (const rule of matches.activeRules) {
        uniqueRuleIds.add(rule.id);
      }
    }
    return uniqueRuleIds.size;
  }, [portMatchesById]);

  const openForwardDialog = useCallback((port: ListeningPortInfo) => {
    const matches = matchListeningPortForwardRules(
      port,
      quickForward.hostId,
      quickForward.allRules,
    );
    const suggestedLocalPort = matches.reusableInactiveRule?.localPort
      ?? suggestQuickForwardLocalPort(port.port, quickForward.allRules);
    const suggestedBind = matches.reusableInactiveRule?.bindAddress
      || DEFAULT_QUICK_FORWARD_BIND_ADDRESS;
    setForwardDialogInitialPort(suggestedLocalPort);
    setForwardDialogInitialBind(suggestedBind);
    setForwardError(null);
    setForwardDialogPort(port);
  }, [quickForward.allRules, quickForward.hostId]);

  const handleSubmitForward = useCallback(async (values: { localPort: number; bindAddress: string }) => {
    const port = forwardDialogPort;
    if (!port) return;
    const requestedSessionId = sessionId;
    setForwardBusy(true);
    setForwardError(null);
    setActionError(null);
    try {
      const result = await quickForward.startQuickForward({
        port,
        localPort: values.localPort,
        bindAddress: values.bindAddress,
      });
      if (sessionIdRef.current !== requestedSessionId) return;
      if (!result.success) {
        setForwardError(result.error || t('systemManager.ports.forwardFailed'));
        return;
      }
      setForwardDialogPort(null);
      const localEndpoint = formatHostPort(values.bindAddress, values.localPort);
      const remoteEndpoint = formatHostPort(resolveForwardRemoteHost(port), port.port);
      toast.success(
        t('systemManager.ports.forwardStarted', {
          local: localEndpoint,
          remote: remoteEndpoint,
        }),
      );
    } finally {
      if (sessionIdRef.current === requestedSessionId) {
        setForwardBusy(false);
      }
    }
  }, [forwardDialogPort, quickForward, sessionId, t]);

  const handleStopForward = useCallback(async (rule: PortForwardingRule) => {
    const requestedSessionId = sessionId;
    setActionError(null);
    const result = await quickForward.stopQuickForward(rule);
    if (sessionIdRef.current !== requestedSessionId) return;
    if (!result.success) {
      setActionError(result.error || t('systemManager.errors.actionFailed'));
      return;
    }
    toast.info(
      t('systemManager.ports.forwardStopped', {
        local: formatHostPort(rule.bindAddress, rule.localPort),
      }),
    );
  }, [quickForward, sessionId, t]);

  const handleCopyLocalEndpoint = useCallback((rule: PortForwardingRule) => {
    const endpoint = formatCopyableLocalEndpoint(rule.bindAddress, rule.localPort);
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(endpoint).then(() => {
        toast.success(t('systemManager.ports.copiedEndpoint', { endpoint }));
      }).catch(() => {});
    }
  }, [t]);

  const executeTerminate = useCallback(async (pid: number) => {
    const requestedSessionId = sessionId;
    setKillBusy(true);
    setActionError(null);
    try {
      const result = await backend.signalSystemProcess({
        sessionId: requestedSessionId,
        pid,
        signal: 'TERM',
      });
      if (sessionIdRef.current !== requestedSessionId) return;
      if (result.pending) {
        setActionError(t('systemManager.errors.sshChannelUnavailable'));
        return;
      }
      if (!result.success) {
        setActionError(result.error || t('systemManager.errors.actionFailed'));
        return;
      }
      void refresh();
    } finally {
      if (sessionIdRef.current === requestedSessionId) setKillBusy(false);
    }
  }, [backend, refresh, sessionId, t]);

  const hostLabel = portForwardingContext?.sessionHost?.label
    || portForwardingContext?.session?.hostLabel
    || portForwardingContext?.sessionHost?.hostname;

  return (
    <SystemPanelShell section="system-manager-ports">
      <SystemPanelToolbar
        trailing={(
          <SystemPanelRefreshButton
            title={t('history.action.refresh')}
            loading={isRefreshActive}
            onClick={() => void refresh()}
          />
        )}
      >
        <SystemPanelSearch
          value={query}
          onChange={setQuery}
          placeholder={t('systemManager.ports.search')}
        />
      </SystemPanelToolbar>

      <SystemPanelSegmented
        value={filter}
        onChange={setFilter}
        options={[
          { id: 'all', label: t('systemManager.ports.filter.all') },
          { id: 'tcp', label: 'TCP' },
          { id: 'udp', label: 'UDP' },
        ]}
      />

      <SystemPanelMetaBar>
        {activeForwardCount > 0
          ? `${t('systemManager.ports.meta', { count: ports.length })} · ${t('systemManager.ports.forwardedMeta', { count: activeForwardCount })}`
          : t('systemManager.ports.meta', { count: ports.length })}
      </SystemPanelMetaBar>

      {actionError ? <SystemPanelInlineError message={actionError} /> : null}

      {error && !(data?.length) ? (
        <SystemPanelError
          message={error}
          onRetry={() => void refresh()}
          retryLabel={t('history.action.retry')}
          loading={loading}
        />
      ) : !(data?.length) && (loading || listPending) ? (
        <SystemPanelLoading message={t('systemManager.ports.loading')} />
      ) : !ports.length ? (
        <SystemPanelEmpty icon={Network} message={t('systemManager.ports.empty')} />
      ) : (
        <SystemPanelList>
          {ports.map((port) => {
            const canForwardRow = quickForward.canForward && isForwardableListeningPort(port);
            const matches = canForwardRow ? portMatchesById.get(port.id) : undefined;
            const activeRule = matches?.primaryActiveRule;
            const extraActiveCount = Math.max(0, (matches?.activeRules.length ?? 0) - 1);
            const isStopPending = Boolean(activeRule && quickForward.pendingRuleIds.has(activeRule.id));

            const trailingBadge = activeRule ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring hover:opacity-90 transition-opacity"
                    aria-label={t('systemManager.ports.copyEndpointAria', {
                      endpoint: formatCopyableLocalEndpoint(activeRule.bindAddress, activeRule.localPort),
                    })}
                    onClick={(event) => {
                      event.stopPropagation();
                      handleCopyLocalEndpoint(activeRule);
                    }}
                  >
                    <SystemPanelStatusBadge tone={activeRule.status === 'active' ? 'success' : 'warning'}>
                      {extraActiveCount > 0
                        ? `→ :${activeRule.localPort} +${extraActiveCount}`
                        : `→ :${activeRule.localPort}`}
                    </SystemPanelStatusBadge>
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  <div className="space-y-0.5 text-xs">
                    <div className="font-mono">
                      {formatHostPort(activeRule.bindAddress, activeRule.localPort)}
                      {' → '}
                      {formatHostPort(
                        activeRule.remoteHost || resolveForwardRemoteHost(port),
                        activeRule.remotePort ?? port.port,
                      )}
                    </div>
                    <div className="text-[10px] opacity-80">
                      {activeRule.status === 'connecting'
                        ? (activeRule.error || t('systemManager.ports.forwarding'))
                        : t('systemManager.ports.clickToCopy')}
                    </div>
                  </div>
                </TooltipContent>
              </Tooltip>
            ) : (
              <SystemPanelStatusBadge tone="muted">
                {port.protocol.toUpperCase()}
              </SystemPanelStatusBadge>
            );

            const hasActions = canForwardRow || (allowMutations && port.pid != null);

            return (
              <SystemPanelRow
                key={port.id}
                title={formatHostPort(port.address, port.port)}
                subtitle={
                  port.processName
                    ? `${port.processName}${port.pid != null ? ` · PID ${port.pid}` : ''}`
                    : (port.pid != null ? `PID ${port.pid}` : t('systemManager.ports.unknownProcess'))
                }
                trailing={trailingBadge}
                actions={hasActions ? (
                  <>
                    {canForwardRow ? (
                      activeRule ? (
                        <SystemPanelRoundButton
                          title={t('systemManager.ports.stopForward')}
                          loading={isStopPending}
                          onClick={() => void handleStopForward(activeRule)}
                        >
                          <Square size={10} />
                        </SystemPanelRoundButton>
                      ) : (
                        <SystemPanelRoundButton
                          title={t('systemManager.ports.forward')}
                          onClick={() => openForwardDialog(port)}
                        >
                          <ArrowRightLeft size={12} />
                        </SystemPanelRoundButton>
                      )
                    ) : null}
                    {allowMutations && port.pid != null ? (
                      <SystemPanelRoundButton
                        title={t('systemManager.ports.terminate')}
                        destructive
                        onClick={() => setPendingKillPid(port.pid)}
                      >
                        <Skull size={12} />
                      </SystemPanelRoundButton>
                    ) : null}
                  </>
                ) : null}
              />
            );
          })}
        </SystemPanelList>
      )}

      <QuickPortForwardDialog
        open={forwardDialogPort != null}
        port={forwardDialogPort}
        hostLabel={hostLabel}
        initialLocalPort={forwardDialogInitialPort}
        initialBindAddress={forwardDialogInitialBind}
        rules={quickForward.allRules}
        busy={forwardBusy}
        error={forwardError}
        onOpenChange={(open) => {
          if (!open && !forwardBusy) {
            setForwardDialogPort(null);
            setForwardError(null);
          }
        }}
        onSubmit={(values) => void handleSubmitForward(values)}
      />

      <SystemPanelConfirmDialog
        open={allowMutations && pendingKillPid != null}
        title={t('systemManager.ports.terminate')}
        message={t('systemManager.ports.confirmTerminate', { pid: String(pendingKillPid ?? 0) })}
        confirmLabel={t('systemManager.ports.terminate')}
        destructive
        busy={killBusy}
        onOpenChange={(open) => {
          if (!open && !killBusy) setPendingKillPid(null);
        }}
        onConfirm={() => {
          const pid = pendingKillPid;
          if (pid == null) return;
          setPendingKillPid(null);
          void executeTerminate(pid);
        }}
      />
    </SystemPanelShell>
  );
});
