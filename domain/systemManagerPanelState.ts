export type CapabilityPanelState = "hidden" | "checking" | "unavailable" | "ready";

export function resolveCapabilityPanelState({
  isActive,
  ready,
  capabilitiesKnown,
}: {
  isActive: boolean;
  ready: boolean;
  capabilitiesKnown: boolean;
}): CapabilityPanelState {
  if (!isActive) return "hidden";
  if (ready) return "ready";
  if (capabilitiesKnown) return "unavailable";
  return "checking";
}
