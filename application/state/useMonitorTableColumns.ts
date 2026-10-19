import { useEffect, useRef, useState, type PointerEvent } from "react";
import {
  clampMonitorColumnWidth,
  normalizeMonitorColumnWidths,
  normalizeMonitorHiddenColumns,
  type MonitorColumn,
} from "../../domain/monitorTableLayout";
import { localStorageAdapter } from "../../infrastructure/persistence/localStorageAdapter";
import {
  STORAGE_KEY_MONITOR_TABLE_COLUMNS,
  STORAGE_KEY_MONITOR_HIDDEN_COLUMNS,
} from "../../infrastructure/config/storageKeys";

export function useMonitorTableColumns() {
  const [widths, setWidths] = useState(() =>
    normalizeMonitorColumnWidths(
      localStorageAdapter.read(STORAGE_KEY_MONITOR_TABLE_COLUMNS),
    ),
  );
  const [hidden, setHidden] = useState(() =>
    normalizeMonitorHiddenColumns(
      localStorageAdapter.read(STORAGE_KEY_MONITOR_HIDDEN_COLUMNS),
    ),
  );
  const currentHidden = useRef(hidden);
  const setVisible = (key: MonitorColumn, visible: boolean) => {
    const previous = currentHidden.current;
    const next = normalizeMonitorHiddenColumns(
      visible ? previous.filter((item) => item !== key) : [...previous, key],
    );
    currentHidden.current = next;
    setHidden(next);
    localStorageAdapter.write(STORAGE_KEY_MONITOR_HIDDEN_COLUMNS, next);
  };
  const current = useRef(widths);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  const resize = (key: MonitorColumn, width: number, persist = true) => {
    current.current = {
      ...current.current,
      [key]: clampMonitorColumnWidth(key, width),
    };
    setWidths(current.current);
    if (persist)
      localStorageAdapter.write(
        STORAGE_KEY_MONITOR_TABLE_COLUMNS,
        current.current,
      );
  };
  const startResize = (
    key: MonitorColumn,
    event: PointerEvent<HTMLElement>,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    cleanup.current?.();
    const pointerId = event.pointerId;
    const handle = event.currentTarget;
    handle.setPointerCapture(pointerId);
    const start = event.clientX;
    const width = current.current[key];
    const cursor = document.body.style.cursor;
    const userSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (next: globalThis.PointerEvent) => {
      if (next.pointerId === pointerId)
        resize(key, width + next.clientX - start, false);
    };
    const finish = (next: globalThis.PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      localStorageAdapter.write(
        STORAGE_KEY_MONITOR_TABLE_COLUMNS,
        current.current,
      );
      cleanup.current?.();
    };
    const blur = () => {
      localStorageAdapter.write(
        STORAGE_KEY_MONITOR_TABLE_COLUMNS,
        current.current,
      );
      cleanup.current?.();
    };
    cleanup.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", blur);
      if (handle.hasPointerCapture(pointerId))
        handle.releasePointerCapture(pointerId);
      document.body.style.cursor = cursor;
      document.body.style.userSelect = userSelect;
      cleanup.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("blur", blur);
  };
  return { widths, resize, startResize, hidden, setVisible };
}
