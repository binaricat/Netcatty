import type { SystemManagerSubTab } from '../../domain/systemManager/types';
import type { ToolbarItemLayoutDefaults } from '../../domain/toolbarItemLayout';

/** Canonical System Manager sub-tab order (all known sections). */
export const SYSTEM_MANAGER_TAB_DEFAULT_ORDER: readonly SystemManagerSubTab[] = [
  'overview',
  'processes',
  'ports',
  'services',
  'tmux',
  'zellij',
  'docker',
  'gpu',
] as const;

/**
 * Persistable layout defaults for System Manager sub-tabs.
 * Overview is locked so the panel never loses every reachable section.
 */
export const SYSTEM_MANAGER_TAB_LAYOUT_DEFAULTS: ToolbarItemLayoutDefaults = {
  order: [...SYSTEM_MANAGER_TAB_DEFAULT_ORDER],
  placement: Object.fromEntries(
    SYSTEM_MANAGER_TAB_DEFAULT_ORDER.map((id) => [id, 'show' as const]),
  ),
  lockedIds: ['overview'],
};
