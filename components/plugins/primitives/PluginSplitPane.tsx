import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { PluginSplitPaneWidgetProps, PluginWidgetEventCallback } from './types';

export interface PluginSplitPaneProps extends PluginSplitPaneWidgetProps {
  firstChild: React.ReactNode;
  secondChild: React.ReactNode;
  nodeId: string;
  className?: string;
  inlineStyle?: string;
  onWidgetEvent: PluginWidgetEventCallback;
}

/**
 * 60fps host-managed 2-child split container rendered inside the shadow root so
 * child plugin trees keep full plugin CSS scoping and can nest freely.
 */
export function PluginSplitPane({
  direction = 'horizontal',
  initialSize = 260,
  minSize = 120,
  maxSize = 900,
  collapsible = false,
  collapsed: controlledCollapsed,
  firstChild,
  secondChild,
  nodeId,
  className,
  inlineStyle,
  onWidgetEvent,
}: PluginSplitPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const clampSize = useCallback(
    (raw: number) => Math.max(minSize, Math.min(maxSize, Math.round(raw))),
    [minSize, maxSize],
  );

  const [size, setSize] = useState<number>(() => clampSize(initialSize));
  const [collapsed, setCollapsed] = useState<boolean>(Boolean(controlledCollapsed));
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered] = useState(false);
  const sizeRef = useRef(size);
  sizeRef.current = size;

  useEffect(() => {
    if (controlledCollapsed !== undefined) setCollapsed(controlledCollapsed);
  }, [controlledCollapsed]);

  const isHorizontal = direction !== 'vertical';

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    const startCoord = isHorizontal ? event.clientX : event.clientY;
    const startSize = collapsed ? minSize : sizeRef.current;
    setDragging(true);
    try { target.setPointerCapture(event.pointerId); } catch { /* pointer capture unsupported */ }

    let latestSize = startSize;
    let latestCollapsed = collapsed;

    const onMove = (moveEvent: PointerEvent) => {
      const containerRect = containerRef.current?.getBoundingClientRect();
      const maxFromContainer = containerRect
        ? Math.max(minSize, (isHorizontal ? containerRect.width : containerRect.height) - 64)
        : maxSize;
      const effectiveMax = Math.min(maxSize, maxFromContainer);
      const delta = (isHorizontal ? moveEvent.clientX : moveEvent.clientY) - startCoord;
      const raw = startSize + delta;
      if (collapsible && raw < minSize * 0.5) {
        latestCollapsed = true;
        setCollapsed(true);
      } else {
        latestCollapsed = false;
        latestSize = Math.max(minSize, Math.min(effectiveMax, Math.round(raw)));
        setCollapsed(false);
        setSize(latestSize);
      }
    };

    const onUp = () => {
      setDragging(false);
      try { target.releasePointerCapture(event.pointerId); } catch { /* pointer already released */ }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      onWidgetEvent('resizeEnd', {
        size: latestCollapsed ? 0 : latestSize,
        collapsed: latestCollapsed,
      });
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [isHorizontal, collapsed, minSize, maxSize, collapsible, onWidgetEvent]);

  const handleDoubleClick = useCallback(() => {
    if (!collapsible) return;
    const nextCollapsed = !collapsed;
    setCollapsed(nextCollapsed);
    onWidgetEvent('resizeEnd', {
      size: nextCollapsed ? 0 : sizeRef.current,
      collapsed: nextCollapsed,
    });
  }, [collapsible, collapsed, onWidgetEvent]);

  const setContainerRef = useCallback((el: HTMLDivElement | null) => {
    containerRef.current = el;
    if (!el) return;
    if (inlineStyle) {
      el.setAttribute('style', `${inlineStyle};display:flex;flex-direction:${isHorizontal ? 'row' : 'column'};width:100%;height:100%;min-width:0;min-height:0;overflow:hidden`);
    }
  }, [inlineStyle, isHorizontal]);

  const dividerActive = dragging || hovered;

  return (
    <div
      ref={setContainerRef}
      data-netcatty-remote-node={nodeId}
      data-plugin-widget="split-pane"
      data-direction={isHorizontal ? 'horizontal' : 'vertical'}
      className={className}
      style={{
        display: 'flex',
        flexDirection: isHorizontal ? 'row' : 'column',
        width: '100%',
        height: '100%',
        minWidth: 0,
        minHeight: 0,
        overflow: 'hidden',
        userSelect: dragging ? 'none' : undefined,
      }}
    >
      <div
        data-split-pane="first"
        style={{
          flex: collapsed ? '0 0 0px' : `0 0 ${size}px`,
          display: collapsed ? 'none' : 'flex',
          flexDirection: 'column',
          minWidth: 0,
          minHeight: 0,
          overflow: 'hidden',
        }}
      >
        {firstChild}
      </div>

      <div
        role="separator"
        aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
        aria-valuenow={collapsed ? 0 : size}
        aria-valuemin={minSize}
        aria-valuemax={maxSize}
        data-split-handle=""
        onPointerDown={handlePointerDown}
        onDoubleClick={handleDoubleClick}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        style={{
          position: 'relative',
          flex: isHorizontal ? '0 0 5px' : '0 0 5px',
          cursor: isHorizontal ? 'col-resize' : 'row-resize',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'transparent',
          zIndex: 5,
          touchAction: 'none',
        }}
      >
        <div
          style={{
            width: isHorizontal ? (dividerActive ? '2px' : '1px') : '100%',
            height: isHorizontal ? '100%' : (dividerActive ? '2px' : '1px'),
            background: dividerActive ? 'hsl(var(--primary))' : 'hsl(var(--border))',
            transition: 'background 120ms ease',
          }}
        />
      </div>

      <div
        data-split-pane="second"
        style={{
          flex: '1 1 0%',
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          minHeight: 0,
          overflow: 'hidden',
        }}
      >
        {secondChild}
      </div>
    </div>
  );
}
