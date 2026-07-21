import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { upsertHostById } from '../../domain/host';
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function areDraftValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => areDraftValuesEqual(value, right[index]));
  }
  if (!isPlainRecord(left) || !isPlainRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(right, key)
      && areDraftValuesEqual(left[key], right[key]));
}

function mergeWorkSurfaceDraftValue(
  openedValue: unknown,
  draftValue: unknown,
  latestValue: unknown,
): unknown {
  if (areDraftValuesEqual(draftValue, openedValue)) return latestValue;
  if (!isPlainRecord(draftValue) || !isPlainRecord(latestValue)) {
    return draftValue;
  }

  const openedRecord = isPlainRecord(openedValue) ? openedValue : {};
  const merged: Record<string, unknown> = { ...latestValue };
  const draftKeys = new Set([...Object.keys(openedRecord), ...Object.keys(draftValue)]);
  for (const key of draftKeys) {
    if (!Object.hasOwn(draftValue, key)) {
      delete merged[key];
      continue;
    }
    merged[key] = mergeWorkSurfaceDraftValue(
      openedRecord[key],
      draftValue[key],
      latestValue[key],
    );
  }
  return merged;
}

export function mergeWorkSurfaceHostDraft(
  openedHost: Host,
  draft: Host,
  latestHost: Host,
): Host {
  return mergeWorkSurfaceDraftValue(openedHost, draft, latestHost) as Host;
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
    mergeWorkSurfaceHostDraft(target.openedHost, draft, latestHost),
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
