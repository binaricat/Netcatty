import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  preserveConcurrentHostLineTimestampUpdate,
  upsertHostById,
} from '../../domain/host';
import type { Host } from '../../types';

export type WorkSurfaceHostEditorMode = 'new' | 'edit';

export type WorkSurfaceHostEditorTarget =
  | { mode: 'new'; defaultGroup: string | null; requestId: number }
  | { mode: 'edit'; openedHost: Host; requestId: number };

interface UseWorkSurfaceHostEditorOptions {
  hosts: Host[];
  onUpdateHosts: (hosts: Host[]) => void;
  onSaved?: (mode: WorkSurfaceHostEditorMode) => void;
}

export function buildWorkSurfaceHostEditorKey(target: WorkSurfaceHostEditorTarget): string {
  if (target.mode === 'edit') {
    return `edit:${target.openedHost.id}:${target.requestId}`;
  }
  return `new:${target.defaultGroup ?? 'root'}:${target.requestId}`;
}

export function shouldCloseDeletedWorkSurfaceHost(
  hosts: Host[],
  target: WorkSurfaceHostEditorTarget | null,
): boolean {
  return target?.mode === 'edit'
    && !hosts.some((host) => host.id === target.openedHost.id);
}

export function saveWorkSurfaceHostDraft(
  hosts: Host[],
  target: WorkSurfaceHostEditorTarget,
  draft: Host,
): Host[] | null {
  if (target.mode === 'new') {
    return upsertHostById(hosts, draft);
  }

  const latestHost = hosts.find((host) => host.id === target.openedHost.id);
  if (!latestHost) return null;

  return upsertHostById(
    hosts,
    preserveConcurrentHostLineTimestampUpdate({
      draft,
      openedHost: target.openedHost,
      latestHost,
    }),
  );
}

export function useWorkSurfaceHostEditor({
  hosts,
  onUpdateHosts,
  onSaved,
}: UseWorkSurfaceHostEditorOptions) {
  const [target, setTarget] = useState<WorkSurfaceHostEditorTarget | null>(null);
  const requestIdRef = useRef(0);

  const nextRequestId = useCallback(() => {
    requestIdRef.current += 1;
    return requestIdRef.current;
  }, []);

  const openNew = useCallback((defaultGroup?: string | null) => {
    setTarget({
      mode: 'new',
      defaultGroup: defaultGroup || null,
      requestId: nextRequestId(),
    });
  }, [nextRequestId]);

  const openEdit = useCallback((host: Host) => {
    setTarget({ mode: 'edit', openedHost: host, requestId: nextRequestId() });
  }, [nextRequestId]);

  const close = useCallback(() => {
    setTarget(null);
  }, []);

  const save = useCallback((draft: Host) => {
    if (!target) return;
    const nextHosts = saveWorkSurfaceHostDraft(hosts, target, draft);
    if (!nextHosts) {
      close();
      return;
    }
    onUpdateHosts(nextHosts);
    onSaved?.(target.mode);
    close();
  }, [close, hosts, onSaved, onUpdateHosts, target]);

  useEffect(() => {
    if (shouldCloseDeletedWorkSurfaceHost(hosts, target)) {
      close();
    }
  }, [close, hosts, target]);

  const editorKey = useMemo(
    () => (target ? buildWorkSurfaceHostEditorKey(target) : null),
    [target],
  );

  return {
    target,
    editorKey,
    openNew,
    openEdit,
    close,
    save,
  };
}
