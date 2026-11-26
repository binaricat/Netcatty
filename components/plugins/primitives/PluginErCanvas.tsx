import { Maximize2, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  PluginErCanvasWidgetProps,
  PluginErTable,
  PluginWidgetEventCallback,
} from './types';

const CARD_WIDTH = 236;
const CARD_HEADER_HEIGHT = 34;
const CARD_ROW_HEIGHT = 24;
const CARD_FOOTER_PADDING = 8;
const GRID_GAP_X = 76;
const GRID_GAP_Y = 56;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;

export interface PluginErCanvasProps extends PluginErCanvasWidgetProps {
  onWidgetEvent: PluginWidgetEventCallback;
}

function tableKey(table: Pick<PluginErTable, 'name' | 'schema'>): string {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}

function cardHeight(table: PluginErTable): number {
  return CARD_HEADER_HEIGHT + Math.max(1, table.columns.length) * CARD_ROW_HEIGHT + CARD_FOOTER_PADDING;
}

function computeInitialPositions(tables: PluginErTable[]): Record<string, { x: number; y: number }> {
  const result: Record<string, { x: number; y: number }> = {};
  const colsPerRow = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(tables.length || 1))));
  const colY = Array.from({ length: colsPerRow }, () => 40);

  tables.forEach((table, index) => {
    const key = tableKey(table);
    if (typeof table.x === 'number' && Number.isFinite(table.x) && typeof table.y === 'number' && Number.isFinite(table.y)) {
      result[key] = { x: table.x, y: table.y };
      return;
    }
    const colIdx = index % colsPerRow;
    const x = 40 + colIdx * (CARD_WIDTH + GRID_GAP_X);
    const y = colY[colIdx];
    result[key] = { x, y };
    colY[colIdx] = y + cardHeight(table) + GRID_GAP_Y;
  });

  return result;
}

export function PluginErCanvas({
  tables = [],
  relations = [],
  onWidgetEvent,
}: PluginErCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>(() => computeInitialPositions(tables));
  const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1 });
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [hoveredRelation, setHoveredRelation] = useState<number | null>(null);
  const [panning, setPanning] = useState(false);

  const tableSignature = useMemo(
    () => tables.map((t) => `${tableKey(t)}:${t.x ?? ''}:${t.y ?? ''}`).join('|'),
    [tables],
  );

  useEffect(() => {
    setPositions((prev) => {
      const defaults = computeInitialPositions(tables);
      const next: Record<string, { x: number; y: number }> = {};
      for (const tbl of tables) {
        const key = tableKey(tbl);
        next[key] = prev[key] ?? defaults[key];
      }
      return next;
    });
  }, [tableSignature, tables]);

  const tableLookup = useMemo(() => {
    const byKey = new Map<string, PluginErTable>();
    const byName = new Map<string, PluginErTable>();
    for (const tbl of tables) {
      byKey.set(tableKey(tbl), tbl);
      if (!byName.has(tbl.name)) byName.set(tbl.name, tbl);
    }
    return { byKey, byName };
  }, [tables]);

  const resolveTable = useCallback((ref: string): PluginErTable | undefined => (
    tableLookup.byKey.get(ref) ?? tableLookup.byName.get(ref)
  ), [tableLookup]);

  const fitToView = useCallback(() => {
    const el = containerRef.current;
    if (!el || tables.length === 0) {
      setViewport({ x: 0, y: 0, zoom: 1 });
      return;
    }
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const tbl of tables) {
      const pos = positions[tableKey(tbl)] ?? { x: 0, y: 0 };
      minX = Math.min(minX, pos.x);
      minY = Math.min(minY, pos.y);
      maxX = Math.max(maxX, pos.x + CARD_WIDTH);
      maxY = Math.max(maxY, pos.y + cardHeight(tbl));
    }
    const contentW = Math.max(1, maxX - minX);
    const contentH = Math.max(1, maxY - minY);
    const pad = 48;
    const zoom = Math.max(
      MIN_ZOOM,
      Math.min(1.15, Math.min((rect.width - pad * 2) / contentW, (rect.height - pad * 2) / contentH)),
    );
    const x = (rect.width - contentW * zoom) / 2 - minX * zoom;
    const y = (rect.height - contentH * zoom) / 2 - minY * zoom;
    setViewport({ x, y, zoom });
  }, [tables, positions]);

  useEffect(() => {
    if (typeof requestAnimationFrame !== 'function') {
      fitToView();
      return;
    }
    const frame = requestAnimationFrame(fitToView);
    return () => cancelAnimationFrame(frame);
  }, [tableSignature]);

  const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    const factor = event.deltaY < 0 ? 1.1 : 0.9;
    setViewport((prev) => {
      const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prev.zoom * factor));
      const scale = nextZoom / prev.zoom;
      return {
        zoom: nextZoom,
        x: mouseX - (mouseX - prev.x) * scale,
        y: mouseY - (mouseY - prev.y) * scale,
      };
    });
  }, []);

  const handleCanvasPointerDown = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    if ((event.target as Element).closest?.('[data-er-table]')) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const initialX = viewport.x;
    const initialY = viewport.y;
    setPanning(true);
    const onMove = (moveEvent: PointerEvent) => {
      setViewport((prev) => ({
        ...prev,
        x: initialX + (moveEvent.clientX - startX),
        y: initialY + (moveEvent.clientY - startY),
      }));
    };
    const onUp = () => {
      setPanning(false);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [viewport.x, viewport.y]);

  const startCardDrag = useCallback((event: React.PointerEvent<SVGGElement>, table: PluginErTable) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const key = tableKey(table);
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = positions[key] ?? { x: 0, y: 0 };
    const zoom = viewport.zoom;
    let moved = false;

    const onMove = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      if (!moved) return;
      setPositions((prev) => ({
        ...prev,
        [key]: { x: Math.round(origin.x + dx / zoom), y: Math.round(origin.y + dy / zoom) },
      }));
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (!moved) {
        setSelectedTable(key);
        onWidgetEvent('tableClick', {
          table: table.name,
          ...(table.schema ? { schema: table.schema } : {}),
        });
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [positions, viewport.zoom, onWidgetEvent]);

  const zoomBy = useCallback((factor: number) => {
    const el = containerRef.current;
    const rect = el?.getBoundingClientRect();
    const cx = rect ? rect.width / 2 : 300;
    const cy = rect ? rect.height / 2 : 200;
    setViewport((prev) => {
      const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prev.zoom * factor));
      const scale = nextZoom / prev.zoom;
      return {
        zoom: nextZoom,
        x: cx - (cx - prev.x) * scale,
        y: cy - (cy - prev.y) * scale,
      };
    });
  }, []);

  const resetLayout = useCallback(() => {
    setPositions(computeInitialPositions(tables));
    requestAnimationFrame(fitToView);
  }, [tables, fitToView]);

  return (
    <div
      ref={containerRef}
      data-plugin-er-canvas=""
      onWheel={handleWheel}
      className="relative h-full w-full min-h-0 min-w-0 overflow-hidden bg-background text-foreground select-none"
    >
      {/* Floating Canvas Controls */}
      <div className="absolute right-3 top-3 z-20 flex items-center gap-1 rounded-lg border border-border bg-background/95 p-1 shadow-sm backdrop-blur-sm">
        <button
          type="button"
          onClick={() => zoomBy(1.2)}
          aria-label="Zoom in"
          title="Zoom in"
          className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-accent text-muted-foreground hover:text-foreground"
        >
          <ZoomIn size={13} />
        </button>
        <span className="min-w-[40px] text-center font-mono text-[11px] tabular-nums text-muted-foreground">
          {Math.round(viewport.zoom * 100)}%
        </span>
        <button
          type="button"
          onClick={() => zoomBy(1 / 1.2)}
          aria-label="Zoom out"
          title="Zoom out"
          className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-accent text-muted-foreground hover:text-foreground"
        >
          <ZoomOut size={13} />
        </button>
        <div className="mx-0.5 h-4 w-px bg-border" />
        <button
          type="button"
          onClick={fitToView}
          aria-label="Fit to view"
          title="Fit to view"
          className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Maximize2 size={12} />
          Fit
        </button>
        <button
          type="button"
          onClick={resetLayout}
          aria-label="Reset layout"
          title="Reset layout"
          className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-accent text-muted-foreground hover:text-foreground"
        >
          <RotateCcw size={12} />
        </button>
      </div>

      {tables.length === 0 ? (
        <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
          No tables to visualize
        </div>
      ) : (
        <svg
          className={`h-full w-full ${panning ? 'cursor-grabbing' : 'cursor-grab'}`}
          onPointerDown={handleCanvasPointerDown}
        >
          <defs>
            <pattern id="nc-er-dots" width="20" height="20" patternUnits="userSpaceOnUse">
              <circle cx="1" cy="1" r="1" fill="hsl(var(--border))" opacity="0.55" />
            </pattern>
            <filter id="nc-er-shadow" x="-10%" y="-10%" width="120%" height="125%">
              <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="#000000" floodOpacity="0.14" />
            </filter>
          </defs>
          <rect width="100%" height="100%" fill="url(#nc-er-dots)" />

          <g transform={`translate(${viewport.x}, ${viewport.y}) scale(${viewport.zoom})`}>
            {/* Foreign Key Bezier Curves */}
            {relations.map((rel, idx) => {
              const fromTable = resolveTable(rel.fromTable);
              const toTable = resolveTable(rel.toTable);
              if (!fromTable || !toTable) return null;
              const fromKey = tableKey(fromTable);
              const toKey = tableKey(toTable);
              const fromPos = positions[fromKey] ?? { x: 0, y: 0 };
              const toPos = positions[toKey] ?? { x: 0, y: 0 };
              const fromColIdx = Math.max(0, fromTable.columns.findIndex((c) => c.name === rel.fromColumn));
              const toColIdx = Math.max(0, toTable.columns.findIndex((c) => c.name === rel.toColumn));
              const y1 = fromPos.y + CARD_HEADER_HEIGHT + fromColIdx * CARD_ROW_HEIGHT + CARD_ROW_HEIGHT / 2;
              const y2 = toPos.y + CARD_HEADER_HEIGHT + toColIdx * CARD_ROW_HEIGHT + CARD_ROW_HEIGHT / 2;
              const fromCenter = fromPos.x + CARD_WIDTH / 2;
              const toCenter = toPos.x + CARD_WIDTH / 2;
              const goRight = toCenter >= fromCenter;
              const x1 = goRight ? fromPos.x + CARD_WIDTH : fromPos.x;
              const x2 = goRight ? toPos.x : toPos.x + CARD_WIDTH;
              const dx = Math.max(48, Math.abs(x2 - x1) * 0.45);
              const c1x = goRight ? x1 + dx : x1 - dx;
              const c2x = goRight ? x2 - dx : x2 + dx;
              const highlighted = hoveredRelation === idx || selectedTable === fromKey || selectedTable === toKey;
              const stroke = highlighted ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))';

              return (
                <g
                  key={rel.name ?? `${fromKey}.${rel.fromColumn}->${toKey}.${rel.toColumn}:${idx}`}
                  onPointerEnter={() => setHoveredRelation(idx)}
                  onPointerLeave={() => setHoveredRelation(null)}
                >
                  <path
                    d={`M ${x1} ${y1} C ${c1x} ${y1}, ${c2x} ${y2}, ${x2} ${y2}`}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={12}
                  />
                  <path
                    d={`M ${x1} ${y1} C ${c1x} ${y1}, ${c2x} ${y2}, ${x2} ${y2}`}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={highlighted ? 2.2 : 1.4}
                    strokeOpacity={highlighted ? 1 : 0.65}
                  />
                  <circle cx={x1} cy={y1} r={3.5} fill={stroke} />
                  <circle cx={x2} cy={y2} r={3.5} fill="hsl(var(--background))" stroke={stroke} strokeWidth={1.8} />
                  {rel.name && highlighted && (
                    <text
                      x={(x1 + x2) / 2}
                      y={(y1 + y2) / 2 - 6}
                      textAnchor="middle"
                      fontSize={10}
                      fontFamily="var(--font-mono)"
                      fill="hsl(var(--primary))"
                    >
                      {rel.name}
                    </text>
                  )}
                </g>
              );
            })}

            {/* Table Cards */}
            {tables.map((table) => {
              const key = tableKey(table);
              const pos = positions[key] ?? { x: 0, y: 0 };
              const height = cardHeight(table);
              const isSelected = selectedTable === key;

              return (
                <g
                  key={key}
                  data-er-table={table.name}
                  transform={`translate(${pos.x}, ${pos.y})`}
                  onPointerDown={(e) => startCardDrag(e, table)}
                  className="cursor-pointer"
                  filter="url(#nc-er-shadow)"
                >
                  <rect
                    width={CARD_WIDTH}
                    height={height}
                    rx={8}
                    fill="hsl(var(--card))"
                    stroke={isSelected ? 'hsl(var(--primary))' : 'hsl(var(--border))'}
                    strokeWidth={isSelected ? 2 : 1}
                  />
                  {/* Header band */}
                  <path
                    d={`M 0 8 Q 0 0 8 0 L ${CARD_WIDTH - 8} 0 Q ${CARD_WIDTH} 0 ${CARD_WIDTH} 8 L ${CARD_WIDTH} ${CARD_HEADER_HEIGHT} L 0 ${CARD_HEADER_HEIGHT} Z`}
                    fill="hsl(var(--muted))"
                  />
                  <line
                    x1={0}
                    y1={CARD_HEADER_HEIGHT}
                    x2={CARD_WIDTH}
                    y2={CARD_HEADER_HEIGHT}
                    stroke="hsl(var(--border))"
                    strokeWidth={1}
                  />
                  <text
                    x={12}
                    y={21}
                    fontSize={12}
                    fontWeight={600}
                    fontFamily="var(--font-sans)"
                    fill="hsl(var(--card-foreground))"
                  >
                    {table.schema ? `${table.schema}.${table.name}` : table.name}
                  </text>

                  {/* Columns */}
                  {table.columns.map((col, colIdx) => {
                    const rowY = CARD_HEADER_HEIGHT + colIdx * CARD_ROW_HEIGHT;
                    const badgeOffset = (col.isPk ? 26 : 0) + (col.isFk ? 26 : 0);
                    return (
                      <g key={col.name} transform={`translate(0, ${rowY})`}>
                        {colIdx > 0 && (
                          <line
                            x1={8}
                            y1={0}
                            x2={CARD_WIDTH - 8}
                            y2={0}
                            stroke="hsl(var(--border))"
                            strokeOpacity={0.45}
                            strokeWidth={0.75}
                          />
                        )}
                        {col.isPk && (
                          <g transform="translate(8, 5)">
                            <rect width={22} height={14} rx={3} fill="#f59e0b" fillOpacity={0.2} />
                            <text x={11} y={10.5} textAnchor="middle" fontSize={9} fontWeight={700} fill="#d97706">
                              PK
                            </text>
                          </g>
                        )}
                        {col.isFk && (
                          <g transform={`translate(${col.isPk ? 34 : 8}, 5)`}>
                            <rect width={22} height={14} rx={3} fill="#3b82f6" fillOpacity={0.2} />
                            <text x={11} y={10.5} textAnchor="middle" fontSize={9} fontWeight={700} fill="#2563eb">
                              FK
                            </text>
                          </g>
                        )}
                        <text
                          x={10 + badgeOffset}
                          y={16}
                          fontSize={11}
                          fontFamily="var(--font-mono)"
                          fill="hsl(var(--card-foreground))"
                        >
                          {col.name.length > 18 ? `${col.name.slice(0, 17)}…` : col.name}
                        </text>
                        <text
                          x={CARD_WIDTH - 10}
                          y={16}
                          textAnchor="end"
                          fontSize={10}
                          fontFamily="var(--font-mono)"
                          fill="hsl(var(--muted-foreground))"
                        >
                          {`${col.type}${col.nullable ? '?' : ''}`.slice(0, 14)}
                        </text>
                      </g>
                    );
                  })}
                </g>
              );
            })}
          </g>
        </svg>
      )}
    </div>
  );
}
