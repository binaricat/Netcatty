import { useCallback, useEffect, useMemo, useState } from 'react';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import { STORAGE_KEY_AI_PERMISSION_GRANTS } from '../../infrastructure/config/storageKeys';
import {
  sanitizePermissionGrants,
  setActivePermissionGrants,
  type PermissionGrantRule,
} from '../../infrastructure/ai/harness/permissionGrants';
import { getAIBridge } from './aiStateSnapshots';
import { AI_STATE_CHANGED_EVENT, emitAIStateChanged } from './aiStateEvents';

function readPermissionGrants(): PermissionGrantRule[] {
  return sanitizePermissionGrants(localStorageAdapter.read<unknown>(STORAGE_KEY_AI_PERMISSION_GRANTS));
}

function syncPermissionGrantsToMainProcess(rules: PermissionGrantRule[]): void {
  void getAIBridge()?.aiMcpSyncPermissionGrants?.(rules)?.catch(() => {});
}

function writePermissionGrants(rules: PermissionGrantRule[]): void {
  localStorageAdapter.write(STORAGE_KEY_AI_PERMISSION_GRANTS, rules);
  setActivePermissionGrants(rules);
  syncPermissionGrantsToMainProcess(rules);
  emitAIStateChanged(STORAGE_KEY_AI_PERMISSION_GRANTS);
}

export function useAIPermissionGrantsState() {
  const [rules, setRulesRaw] = useState<PermissionGrantRule[]>(() => {
    const initial = readPermissionGrants();
    setActivePermissionGrants(initial);
    return initial;
  });

  const setRules = useCallback((value: PermissionGrantRule[] | ((prev: PermissionGrantRule[]) => PermissionGrantRule[])) => {
    setRulesRaw((prev) => {
      const next = typeof value === 'function' ? value(prev) : value;
      writePermissionGrants(next);
      return next;
    });
  }, []);

  const addGrant = useCallback((rule: PermissionGrantRule) => {
    setRules((prev) => [...prev, rule]);
  }, [setRules]);

  const updateGrant = useCallback((
    id: string,
    updates: Partial<Omit<PermissionGrantRule, 'id' | 'createdAt'>>,
  ) => {
    setRules((prev) => prev.map((rule) => (
      rule.id === id ? { ...rule, ...updates } : rule
    )));
  }, [setRules]);

  const removeGrant = useCallback((id: string) => {
    setRules((prev) => prev.filter((rule) => rule.id !== id));
  }, [setRules]);

  const importGrants = useCallback((raw: unknown, mode: 'merge' | 'replace' = 'replace') => {
    const imported = sanitizePermissionGrants(raw);
    setRules((prev) => (mode === 'merge' ? [...prev, ...imported] : imported));
  }, [setRules]);

  const exportGrants = useCallback((): PermissionGrantRule[] => {
    return readPermissionGrants();
  }, []);

  useEffect(() => {
    const syncFromStorageKey = (key: string | null) => {
      if (key !== STORAGE_KEY_AI_PERMISSION_GRANTS) return;
      const next = readPermissionGrants();
      setActivePermissionGrants(next);
      syncPermissionGrantsToMainProcess(next);
      setRulesRaw(next);
    };

    const handleStorage = (event: StorageEvent) => syncFromStorageKey(event.key);
    const handleLocalStateChanged = (event: Event) => {
      syncFromStorageKey((event as CustomEvent<{ key?: string }>).detail?.key ?? null);
    };

    window.addEventListener('storage', handleStorage);
    window.addEventListener(AI_STATE_CHANGED_EVENT, handleLocalStateChanged);
    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener(AI_STATE_CHANGED_EVENT, handleLocalStateChanged);
    };
  }, []);

  useEffect(() => {
    const bridge = getAIBridge();
    bridge?.aiMcpSyncPermissionGrants?.(rules);
  }, [rules]);

  return useMemo(() => ({
    permissionGrants: rules,
    setPermissionGrants: setRules,
    addGrant,
    updateGrant,
    removeGrant,
    importGrants,
    exportGrants,
  }), [rules, setRules, addGrant, updateGrant, removeGrant, importGrants, exportGrants]);
}
