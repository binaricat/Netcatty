import { useCallback } from 'react';

import { hostTreeInlineGroupEditStore } from '../../application/state/hostTreeInlineGroupEditStore';
import { hostTreeInlineHostEditStore } from '../../application/state/hostTreeInlineHostEditStore';
import { applyHostLabelRename } from '../../domain/host';
import type { Host } from '../../types';
import { toast } from '../ui/toast';

type UseHostTreeInlineHostActionsParams = {
  hosts: Host[];
  onUpdateHosts: (hosts: Host[]) => void;
  t: (key: string) => string;
};

export function useHostTreeInlineHostActions({
  hosts,
  onUpdateHosts,
  t,
}: UseHostTreeInlineHostActionsParams) {
  const startInlineRenameHost = useCallback((host: Host) => {
    hostTreeInlineGroupEditStore.clear();
    hostTreeInlineHostEditStore.startEdit({
      hostId: host.id,
      initialName: host.label,
    });
  }, []);

  const cancelInlineHostEdit = useCallback(() => {
    hostTreeInlineHostEditStore.clear();
  }, []);

  const commitInlineHostRename = useCallback((rawName: string) => {
    const edit = hostTreeInlineHostEditStore.getEdit();
    if (!edit) return;

    const result = applyHostLabelRename(hosts, edit.hostId, rawName);
    if (!result.ok) {
      toast.error(t('vault.hosts.errors.nameRequired'));
      return;
    }

    if (result.changed) {
      onUpdateHosts(result.hosts);
    }
    hostTreeInlineHostEditStore.clear();
  }, [hosts, onUpdateHosts, t]);

  return {
    startInlineRenameHost,
    commitInlineHostRename,
    cancelInlineHostEdit,
  };
}
