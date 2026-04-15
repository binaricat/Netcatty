export function tryBeginDraftSend(gate: { current: boolean }): boolean {
  if (gate.current) {
    return false;
  }

  gate.current = true;
  return true;
}

export function endDraftSend(gate: { current: boolean }): void {
  gate.current = false;
}
