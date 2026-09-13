// Delay the configured short-click action only while a local long press is
// possible. Mouse-reporting applications retain their original press/release.
export const RIGHT_CLICK_LONG_PRESS_MS = 500;

export function installRightClickLongPress(
  root: HTMLElement,
  canStart: () => boolean,
): () => void {
  const doc = root.ownerDocument;
  const win = doc.defaultView!;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let press: MouseEvent | undefined;
  let suppressContextMenu = false;
  const replayEvents = new WeakSet<Event>();

  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    press = undefined;
  };
  const dispatch = (event: MouseEvent, longPress: boolean) => {
    const replay = new win.MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: event.clientX,
      clientY: event.clientY,
      // The existing Shift+right-click path opens the same menu.
      shiftKey: longPress,
    });
    replayEvents.add(replay);
    // Dispatch on the surface to avoid xterm's textarea focus interception.
    root.dispatchEvent(replay);
  };
  const onDown = (event: MouseEvent) => {
    cancel();
    suppressContextMenu = false;
    if (event.button !== 2 || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey
      || !canStart()
      || (event.target as Element | null)?.closest('[data-terminal-history-preview]')) return;
    press = event;
    suppressContextMenu = true;
    timer = setTimeout(() => {
      const pending = press;
      cancel();
      if (pending && canStart()) dispatch(pending, true);
    }, RIGHT_CLICK_LONG_PRESS_MS);
  };
  const onUp = (event: MouseEvent) => {
    if (event.button !== 2 || !press) return;
    const pending = press;
    cancel();
    if (root.contains(event.target as Node) && canStart()) dispatch(pending, false);
  };
  const onMove = (event: MouseEvent) => {
    if (press && (Math.hypot(event.clientX - press.clientX, event.clientY - press.clientY) > 8
      || !(event.buttons & 2))) cancel();
  };
  const onContextMenu = (event: MouseEvent) => {
    // Native contextmenu arrives on press on macOS/Linux, on release on Windows.
    if (suppressContextMenu && event.button === 2 && !replayEvents.has(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  root.addEventListener('mousedown', onDown, true);
  root.addEventListener('contextmenu', onContextMenu, true);
  doc.addEventListener('mouseup', onUp, true);
  doc.addEventListener('mousemove', onMove, true);
  win.addEventListener('blur', cancel);
  return () => {
    cancel();
    root.removeEventListener('mousedown', onDown, true);
    root.removeEventListener('contextmenu', onContextMenu, true);
    doc.removeEventListener('mouseup', onUp, true);
    doc.removeEventListener('mousemove', onMove, true);
    win.removeEventListener('blur', cancel);
  };
}
