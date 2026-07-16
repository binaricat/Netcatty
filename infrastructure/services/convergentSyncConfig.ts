import { STORAGE_KEY_CONVERGENT_SYNC_CONFIG } from '../config/storageKeys';
import { localStorageAdapter } from '../persistence/localStorageAdapter';

export interface ConvergentSyncLocalConfig {
  enabled: boolean;
  initialized: boolean;
}

const DEFAULT_CONFIG: ConvergentSyncLocalConfig = {
  enabled: false,
  initialized: false,
};

export function getConvergentSyncLocalConfig(): ConvergentSyncLocalConfig {
  const stored = localStorageAdapter.read<Partial<ConvergentSyncLocalConfig>>(
    STORAGE_KEY_CONVERGENT_SYNC_CONFIG,
  );
  return {
    enabled: stored?.enabled === true,
    initialized: stored?.initialized === true,
  };
}

export function setConvergentSyncLocalConfig(
  config: ConvergentSyncLocalConfig,
): ConvergentSyncLocalConfig {
  const normalized = {
    enabled: config.enabled === true,
    initialized: config.initialized === true,
  };
  if (!localStorageAdapter.write(STORAGE_KEY_CONVERGENT_SYNC_CONFIG, normalized)) {
    throw new Error('Unable to persist convergent sync configuration');
  }
  return normalized;
}

/** Disabling after initialization pauses v2; it never removes replica metadata. */
export function pauseConvergentSync(): ConvergentSyncLocalConfig {
  const current = getConvergentSyncLocalConfig();
  return setConvergentSyncLocalConfig({
    enabled: false,
    initialized: current.initialized,
  });
}

export function markConvergentSyncInitialized(): ConvergentSyncLocalConfig {
  return setConvergentSyncLocalConfig({ enabled: true, initialized: true });
}

export function clearConvergentSyncLocalConfigAfterDowngrade(
  confirmed: boolean,
): ConvergentSyncLocalConfig {
  if (!confirmed) throw new Error('Explicit confirmation is required to downgrade convergent sync');
  return setConvergentSyncLocalConfig(DEFAULT_CONFIG);
}
