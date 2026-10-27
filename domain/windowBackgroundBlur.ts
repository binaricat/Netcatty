export function isWindowBackgroundBlurActive(
  requested: boolean,
  windowOpacity: number,
): boolean {
  return requested && Number.isFinite(windowOpacity) && windowOpacity < 1;
}
