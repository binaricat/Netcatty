export const VAULT_HOST_GRID_GAP = 12;
export const VAULT_HOST_GRID_MIN_CARD_WIDTH = 220;
export const VAULT_HOST_GRID_MAX_COLUMNS = 4;

export function getVaultHostGridColumnCount(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 1;
  return Math.min(
    VAULT_HOST_GRID_MAX_COLUMNS,
    Math.max(
      1,
      Math.floor(
        (width + VAULT_HOST_GRID_GAP)
        / (VAULT_HOST_GRID_MIN_CARD_WIDTH + VAULT_HOST_GRID_GAP),
      ),
    ),
  );
}
