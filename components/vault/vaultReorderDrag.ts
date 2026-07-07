import React from "react";

export type VaultDropPosition = "before" | "after";
export type VaultDropIntent = VaultDropPosition | "inside";
export type VaultDropAxis = "x" | "y";

const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

export const getVaultDropPosition = (
  element: HTMLElement,
  clientX: number,
  clientY: number,
  isGrid = false,
): VaultDropPosition => {
  const rect = element.getBoundingClientRect();
  if (isGrid) return clientX < rect.left + rect.width / 2 ? "before" : "after";
  return clientY < rect.top + rect.height / 2 ? "before" : "after";
};

export const getVaultDropIntent = (
  element: HTMLElement,
  clientX: number,
  clientY: number,
  isGrid: boolean,
): VaultDropIntent => {
  const rect = element.getBoundingClientRect();
  if (isGrid) {
    const edgeSize = Math.max(18, Math.min(36, rect.width * 0.22));
    if (clientX <= rect.left + edgeSize) return "before";
    if (clientX >= rect.right - edgeSize) return "after";
    return "inside";
  }

  const edgeSize = Math.max(8, Math.min(14, rect.height * 0.28));
  if (clientY <= rect.top + edgeSize) return "before";
  if (clientY >= rect.bottom - edgeSize) return "after";
  return "inside";
};

export const hasVaultDragType = (dataTransfer: DataTransfer, type: string) =>
  Array.from(dataTransfer.types).includes(type);

export const handleVaultRootDrop = ({
  dataTransfer,
  preventDefault,
  setDragOverDropTarget,
  moveGroup,
  moveHostToGroup,
  resetHostDragState,
}: {
  dataTransfer: Pick<DataTransfer, "getData">;
  preventDefault: () => void;
  setDragOverDropTarget: (target: null) => void;
  moveGroup: (groupPath: string, targetParentPath: string | null) => void;
  moveHostToGroup: (hostId: string, targetPath: string | null) => void;
  resetHostDragState: () => void;
}) => {
  preventDefault();
  setDragOverDropTarget(null);
  const groupPath = dataTransfer.getData("group-path");
  const hostId = dataTransfer.getData("host-id");
  if (groupPath) moveGroup(groupPath, null);
  if (hostId) {
    moveHostToGroup(hostId, null);
    resetHostDragState();
  }
};

export const handleVaultHostDropToGroup = ({
  dataTransfer,
  groupPath,
  moveHostToGroup,
  resetHostDragState,
}: {
  dataTransfer: Pick<DataTransfer, "getData">;
  groupPath: string | null;
  moveHostToGroup: (hostId: string, targetPath: string | null) => void;
  resetHostDragState: () => void;
}) => {
  const hostId = dataTransfer.getData("host-id");
  if (!hostId) return false;

  moveHostToGroup(hostId, groupPath);
  resetHostDragState();
  return true;
};

let activeVaultDropIndicator: HTMLElement | null = null;

export const clearVaultDropIndicator = () => {
  activeVaultDropIndicator?.removeAttribute("data-vault-drop-position");
  activeVaultDropIndicator?.removeAttribute("data-vault-drop-axis");
  activeVaultDropIndicator = null;
};

export const markVaultDropIndicator = (
  target: HTMLElement,
  position: VaultDropPosition,
  axis: VaultDropAxis = "y",
) => {
  if (target.dataset.vaultDropPosition === position && target.dataset.vaultDropAxis === axis) return;
  clearVaultDropIndicator();
  target.dataset.vaultDropPosition = position;
  target.dataset.vaultDropAxis = axis;
  activeVaultDropIndicator = target;
};

export const markVaultInsideDropIndicator = (target: HTMLElement) => {
  if (target.dataset.vaultDropPosition === "inside") return;
  clearVaultDropIndicator();
  target.dataset.vaultDropPosition = "inside";
  activeVaultDropIndicator = target;
};

export const useVaultGridLayoutAnimation = (
  containerRef: React.RefObject<HTMLElement | null>,
) => {
  const previousRectsRef = React.useRef<Map<string, DOMRect> | null>(null);

  const prepare = React.useCallback(() => {
    const container = containerRef.current;
    if (!container || typeof window === "undefined") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    const rects = new Map<string, DOMRect>();
    container.querySelectorAll<HTMLElement>("[data-vault-grid-item]").forEach((element) => {
      const key = element.dataset.vaultGridItem;
      if (!key) return;
      rects.set(key, element.getBoundingClientRect());
    });
    previousRectsRef.current = rects;
  }, [containerRef]);

  useIsomorphicLayoutEffect(() => {
    const previousRects = previousRectsRef.current;
    if (!previousRects || previousRects.size === 0) return;
    previousRectsRef.current = null;

    const container = containerRef.current;
    if (!container) return;

    container.querySelectorAll<HTMLElement>("[data-vault-grid-item]").forEach((element) => {
      const key = element.dataset.vaultGridItem;
      if (!key || typeof element.animate !== "function") return;
      const previous = previousRects.get(key);
      if (!previous) return;

      const next = element.getBoundingClientRect();
      const deltaX = previous.left - next.left;
      const deltaY = previous.top - next.top;
      if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) return;

      element.animate(
        [
          { transform: `translate(${deltaX}px, ${deltaY}px)` },
          { transform: "translate(0, 0)" },
        ],
        {
          duration: 180,
          easing: "cubic-bezier(0.2, 0, 0, 1)",
        },
      );
    });
  });

  return prepare;
};

export const useVaultItemReorder = ({
  containerRef,
  viewMode,
  dragType,
  targetAttribute,
  onReorder,
  disabled = false,
}: {
  containerRef: React.RefObject<HTMLElement | null>;
  viewMode: "grid" | "list" | string;
  dragType: string;
  targetAttribute: string;
  onReorder: (
    sourceId: string,
    targetId: string,
    position: VaultDropPosition,
  ) => void;
  disabled?: boolean;
}) => {
  const lastPreviewReorderRef = React.useRef<string | null>(null);
  const draggingIdRef = React.useRef<string | null>(null);
  const [draggingId, setDraggingId] = React.useState<string | null>(null);
  const prepareGridLayoutAnimation = useVaultGridLayoutAnimation(containerRef);
  const selector = `[${targetAttribute}]`;

  const reset = React.useCallback(() => {
    lastPreviewReorderRef.current = null;
    draggingIdRef.current = null;
    setDraggingId(null);
    clearVaultDropIndicator();
  }, []);

  const handleDragOverCapture = React.useCallback((event: React.DragEvent<HTMLElement>) => {
    if (disabled) return;
    const target = (event.target as Element | null)?.closest(selector);
    if (!(target instanceof HTMLElement)) return;
    if (!draggingIdRef.current && !hasVaultDragType(event.dataTransfer, dragType)) return;

    const sourceId = draggingIdRef.current || event.dataTransfer.getData(dragType);
    const targetId = target.getAttribute(targetAttribute);
    if (!sourceId || !targetId) return;

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (sourceId === targetId) return;

    const isGrid = viewMode === "grid";
    const position = getVaultDropPosition(target, event.clientX, event.clientY, isGrid);

    if (!isGrid) {
      markVaultDropIndicator(target, position);
      return;
    }

    const previewKey = `${sourceId}:${targetId}:${position}`;
    if (lastPreviewReorderRef.current === previewKey) return;

    prepareGridLayoutAnimation();
    lastPreviewReorderRef.current = previewKey;
    onReorder(sourceId, targetId, position);
  }, [
    disabled,
    dragType,
    onReorder,
    prepareGridLayoutAnimation,
    selector,
    targetAttribute,
    viewMode,
  ]);

  const handleDragOver = React.useCallback((event: React.DragEvent<HTMLElement>) => {
    if (disabled || viewMode === "grid") return;
    const target = (event.target as Element | null)?.closest(selector);
    if (!(target instanceof HTMLElement)) return;
    if (!draggingIdRef.current && !hasVaultDragType(event.dataTransfer, dragType)) return;

    const sourceId = draggingIdRef.current || event.dataTransfer.getData(dragType);
    const targetId = target.getAttribute(targetAttribute);
    if (!sourceId || !targetId) return;

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (sourceId === targetId) return;
    markVaultDropIndicator(
      target,
      getVaultDropPosition(target, event.clientX, event.clientY),
    );
  }, [disabled, dragType, selector, targetAttribute, viewMode]);

  const handleDropCapture = React.useCallback((event: React.DragEvent<HTMLElement>) => {
    if (disabled) return;
    const target = (event.target as Element | null)?.closest(selector);
    clearVaultDropIndicator();
    if (!(target instanceof HTMLElement)) return;

    const sourceId = draggingIdRef.current || event.dataTransfer.getData(dragType);
    const targetId = target.getAttribute(targetAttribute);
    if (!sourceId || !targetId) {
      lastPreviewReorderRef.current = null;
      draggingIdRef.current = null;
      setDraggingId(null);
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (sourceId === targetId) {
      lastPreviewReorderRef.current = null;
      draggingIdRef.current = null;
      setDraggingId(null);
      return;
    }

    const position = getVaultDropPosition(
      target,
      event.clientX,
      event.clientY,
      viewMode === "grid",
    );
    const previewKey = `${sourceId}:${targetId}:${position}`;
    if (viewMode !== "grid" || lastPreviewReorderRef.current !== previewKey) {
      prepareGridLayoutAnimation();
      onReorder(sourceId, targetId, position);
    }
    lastPreviewReorderRef.current = null;
    draggingIdRef.current = null;
    setDraggingId(null);
  }, [
    disabled,
    dragType,
    onReorder,
    prepareGridLayoutAnimation,
    selector,
    targetAttribute,
    viewMode,
  ]);

  const getItemReorderProps = React.useCallback((id: string, gridItemKey = id) => ({
    [targetAttribute]: id,
    "data-vault-grid-item": gridItemKey,
    "data-vault-reorder-grid": viewMode === "grid" ? "true" : undefined,
    "data-vault-reorder-dragging": draggingId === id ? "true" : undefined,
    draggable: !disabled,
    onDragStart: (event: React.DragEvent<HTMLElement>) => {
      if (disabled) return;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(dragType, id);
      draggingIdRef.current = id;
      setDraggingId(id);
    },
  }), [disabled, dragType, draggingId, targetAttribute, viewMode]);

  return {
    handleDragOverCapture,
    handleDragOver,
    handleDropCapture,
    handleDragEndCapture: reset,
    getItemReorderProps,
  };
};
