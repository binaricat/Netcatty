/** Native child views must yield to host dialogs and overlapping portals. */
export function isPluginViewOccluded(mount: HTMLElement): boolean {
  const rect = mount.getBoundingClientRect();
  if (!mount.isConnected || mount.closest('[hidden], [inert], [aria-hidden="true"]')) return true;
  const overlays = mount.ownerDocument.querySelectorAll(
    '[data-app-lock-overlay], [role="dialog"], [role="alertdialog"], '
    + '[role="menu"][data-state="open"], [data-radix-popper-content-wrapper] > *, [data-native-view-occluder]',
  );
  return [...overlays].some((overlay) => {
    if (mount.contains(overlay)) return false;
    const style = getComputedStyle(overlay);
    if (style.display === 'none' || style.visibility === 'hidden' || overlay.closest('[hidden], [inert]')) return false;
    if (overlay.matches('[data-app-lock-overlay], [role="dialog"][aria-modal="true"], [role="alertdialog"]')) return true;
    const other = overlay.getBoundingClientRect();
    return other.width > 0 && other.height > 0 && other.x < rect.right && other.right > rect.x
      && other.y < rect.bottom && other.bottom > rect.y;
  });
}
