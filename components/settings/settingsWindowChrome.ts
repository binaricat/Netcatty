export function getSettingsWindowClassName(isMac: boolean): string {
  return `settings-window h-screen flex flex-col bg-background text-foreground font-sans${isMac ? "" : " border border-border"}`;
}
