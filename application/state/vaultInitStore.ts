let vaultInitialized = false;

export function isVaultInitialized(): boolean {
  return vaultInitialized;
}

export function setVaultInitialized(value: boolean): void {
  vaultInitialized = value;
}
