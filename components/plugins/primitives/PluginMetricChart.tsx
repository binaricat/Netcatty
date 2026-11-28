import React, { useId, useMemo, useRef, useState, useEffect, useCallback } from 'react';
import type {
  PluginMetricChartColor,
  PluginMetricChartPoint,
  PluginMetricChartSeries,
  PluginMetricChartThreshold,
  PluginMetricChartUnit,
  PluginMetricChartWidgetProps,
} from './types';

const MAX_SERIES = 16;
const MAX_POINTS_PER_SERIES = 2000;
const MAX_THRESHOLDS = 8;
const MIN_HEIGHT = 24;
const MAX_HEIGHT = 480;
const DEFAULT_WIDTH = 360;
const DOWNSAMPLE_BUCKETS = 180;

const COLOR_MAP: Record<PluginMetricChartColor, string> = {
  primary: 'hsl(var(--primary))',
  sky: '#0ea5e9',
  emerald: '#10b981',
  amber: '#f59e0b',
  violet: '#8b5cf6',
  rose: '#f43f5e',
  cyan: '#06b6d4',
  muted: 'hsl(var(--muted-foreground))',
};

const DEFAULT_COLOR_CYCLE: PluginMetricChartColor[] = [
  'sky',
  'emerald',
  'amber',
  'violet',
  'rose',
  'cyan',
  'primary',
  'muted',
];

function resolveColor(color: PluginMetricChartColor | undefined, index: number): string {
  if (color && Object.hasOwn(COLOR_MAP, color)) {
    return COLOR_MAP[color];
  }
  return COLOR_MAP[DEFAULT_COLOR_CYCLE[index % DEFAULT_COLOR_CYCLE.length]];
}

export function formatMetricValue(value: number | null | undefined, unit: PluginMetricChartUnit = ''): string {
  if (value == null || !Number.isFinite(value)) return '--';
  if (unit === '%') {
    return `${value.toFixed(value >= 100 || value === 0 ? 0 : 1)}%`;
  }
  if (unit === 'ms') {
    return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
  }
  if (unit === 'temp') {
    return `${value.toFixed(1)} C`;
  }
  if (unit === 'bytes/s' || unit === 'bytes') {
    const suffix = unit === 'bytes/s' ? '/s' : '';
    const abs = Math.abs(value);
    if (abs >= 1024 ** 3) return `${(value / (1024 ** 3)).toFixed(2)} GiB${suffix}`;
    if (abs >= 1024 ** 2) return `${(value / (1024 ** 2)).toFixed(1)} MiB${suffix}`;
    if (abs >= 1024) return `${(value / 1024).toFixed(1)} KiB${suffix}`;
    return `${Math.round(value)} B${suffix}`;
  }
  if (unit === 'count') {
    if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }
  return Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1);
}

function formatClockTime(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return '';
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return '';
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

interface CleanSeries {
  id: string;
  label: string;
  color: string;
  unit: PluginMetricChartUnit;
  points: Array<{ at: number; value: number | null }>;
  latestValue: number | null;
}

interface PlotSegment {
  linePath: string;
  areaPath: string;
  lastX: number;
  lastY: number;
}

function sanitizeSeries(raw: PluginMetricChartSeries[] | undefined): CleanSeries[] {
  if (!Array.isArray(raw)) return [];
  const limited = raw.slice(0, MAX_SERIES);
  const seenIds = new Set<string>();
  return limited
    .filter((item): item is PluginMetricChartSeries => Boolean(item && typeof item === 'object'))
    .map((item, idx) => {
      const rawPoints = Array.isArray(item.points) ? item.points.slice(-MAX_POINTS_PER_SERIES) : [];
      const points: Array<{ at: number; value: number | null }> = [];
      for (const pt of rawPoints) {
        if (!pt || typeof pt !== 'object' || typeof pt.at !== 'number' || !Number.isFinite(pt.at)) continue;
        const val = typeof pt.value === 'number' && Number.isFinite(pt.value) ? pt.value : null;
        points.push({ at: pt.at, value: val });
      }
      points.sort((a, b) => a.at - b.at);
      let latestValue: number | null = null;
      for (let i = points.length - 1; i >= 0; i -= 1) {
        if (points[i].value !== null) {
          latestValue = points[i].value;
          break;
        }
      }
      const baseId = typeof item.id === 'string' && item.id ? item.id : `series-${idx}`;
      const uniqueId = seenIds.has(baseId) ? `${baseId}-${idx}` : baseId;
      seenIds.add(uniqueId);
      return {
        id: uniqueId,
        label: typeof item.label === 'string' && item.label ? item.label : `Series ${idx + 1}`,
        color: resolveColor(item.color, idx),
        unit: item.unit ?? '',
        points,
        latestValue,
      };
    });
}

function sanitizeThresholds(raw: PluginMetricChartThreshold[] | undefined): PluginMetricChartThreshold[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, MAX_THRESHOLDS)
    .filter(
      (t): t is PluginMetricChartThreshold =>
        Boolean(t && typeof t === 'object' && typeof t.value === 'number' && Number.isFinite(t.value) && (t.tone === 'warning' || t.tone === 'critical')),
    );
}

function buildSegments(
  points: PluginMetricChartPoint[],
  startAt: number,
  endAt: number,
  yMin: number,
  yMax: number,
  gapThresholdMs: number,
  plotLeft: number,
  plotTop: number,
  plotWidth: number,
  plotHeight: number,
): PlotSegment[] {
  const spanX = Math.max(1, endAt - startAt);
  const spanY = Math.max(1e-9, yMax - yMin);
  const visible = points.filter((p) => p.at >= startAt && p.at <= endAt);

  const runs: Array<Array<{ at: number; value: number }>> = [];
  let currentRun: Array<{ at: number; value: number }> = [];
  for (const pt of visible) {
    if (pt.value === null || !Number.isFinite(pt.value)) {
      if (currentRun.length > 0) {
        runs.push(currentRun);
        currentRun = [];
      }
      continue;
    }
    if (currentRun.length > 0 && pt.at - currentRun[currentRun.length - 1].at > gapThresholdMs) {
      runs.push(currentRun);
      currentRun = [];
    }
    currentRun.push({ at: pt.at, value: pt.value });
  }
  if (currentRun.length > 0) runs.push(currentRun);

  const baseY = plotTop + plotHeight;
  return runs.map((samples) => {
    const selected = new Set([samples[0], samples[samples.length - 1]]);
    if (samples.length > DOWNSAMPLE_BUCKETS) {
      const buckets = new Map<number, { min: (typeof samples)[number]; max: (typeof samples)[number] }>();
      for (const sample of samples) {
        const col = Math.min(DOWNSAMPLE_BUCKETS - 1, Math.max(0, Math.floor(((sample.at - startAt) / spanX) * DOWNSAMPLE_BUCKETS)));
        const bucket = buckets.get(col);
        if (!bucket) {
          buckets.set(col, { min: sample, max: sample });
        } else {
          if (sample.value < bucket.min.value) bucket.min = sample;
          if (sample.value > bucket.max.value) bucket.max = sample;
        }
      }
      for (const bucket of buckets.values()) {
        selected.add(bucket.min);
        selected.add(bucket.max);
      }
    } else {
      for (const sample of samples) selected.add(sample);
    }

    const coords = samples
      .filter((sample) => selected.has(sample))
      .map((sample) => {
        const ratioX = Math.max(0, Math.min(1, (sample.at - startAt) / spanX));
        const clampedY = Math.max(yMin, Math.min(yMax, sample.value));
        const ratioY = (clampedY - yMin) / spanY;
        return {
          x: plotLeft + ratioX * plotWidth,
          y: plotTop + plotHeight - ratioY * plotHeight,
        };
      });

    const linePath = coords
      .map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.x.toFixed(2)} ${pt.y.toFixed(2)}`)
      .join(' ');
    const first = coords[0];
    const last = coords[coords.length - 1];
    const areaPath = coords.length > 1
      ? `${linePath} L ${last.x.toFixed(2)} ${baseY.toFixed(2)} L ${first.x.toFixed(2)} ${baseY.toFixed(2)} Z`
      : '';
    return { linePath, areaPath, lastX: last.x, lastY: last.y };
  });
}

export function PluginMetricChart(props: PluginMetricChartWidgetProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number>(DEFAULT_WIDTH);
  const [hoverX, setHoverX] = useState<number | null>(null);

  const variant = props.variant ?? 'area';
  const isSparkline = variant === 'sparkline';
  const showAxes = props.showAxes ?? !isSparkline;
  const showGrid = props.showGrid ?? !isSparkline;
  const showLegend = props.showLegend ?? (!isSparkline && (props.series?.length ?? 0) > 1);
  const interactive = props.interactive ?? !isSparkline;
  const chartHeight = Math.max(
    MIN_HEIGHT,
    Math.min(MAX_HEIGHT, typeof props.height === 'number' && Number.isFinite(props.height) ? props.height : (isSparkline ? 40 : 160)),
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const updateWidth = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 16) setWidth(Math.round(rect.width));
    };
    updateWidth();
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(updateWidth);
      observer.observe(el);
      return () => observer.disconnect();
    }
    return undefined;
  }, []);

  const series = useMemo(() => sanitizeSeries(props.series), [props.series]);
  const thresholds = useMemo(() => sanitizeThresholds(props.thresholds), [props.thresholds]);

  const { startAt, endAt, yMin, yMax, hasData, primaryUnit } = useMemo(() => {
    let minAt = Infinity;
    let maxAt = -Infinity;
    let maxVal = -Infinity;
    let minVal = Infinity;
    let dataPoints = 0;

    for (const s of series) {
      for (const p of s.points) {
        if (p.at < minAt) minAt = p.at;
        if (p.at > maxAt) maxAt = p.at;
        if (p.value !== null) {
          dataPoints += 1;
          if (p.value > maxVal) maxVal = p.value;
          if (p.value < minVal) minVal = p.value;
        }
      }
    }

    const resolvedEnd = typeof props.endAt === 'number' && Number.isFinite(props.endAt)
      ? props.endAt
      : (Number.isFinite(maxAt) ? maxAt : Date.now());
    const rawDataSpan = Number.isFinite(minAt) && resolvedEnd > minAt ? resolvedEnd - minAt : NaN;
    const resolvedRange = typeof props.rangeMs === 'number' && Number.isFinite(props.rangeMs) && props.rangeMs > 0
      ? props.rangeMs
      : (Number.isFinite(rawDataSpan) ? Math.max(1000, rawDataSpan) : 5 * 60_000);
    const candidateStart = resolvedEnd - resolvedRange;
    const resolvedStart = Number.isFinite(candidateStart) && Number.isFinite(resolvedEnd - candidateStart)
      ? candidateStart
      : resolvedEnd - 5 * 60_000;

    const unit = series[0]?.unit ?? '';
    const rawMin = typeof props.min === 'number' && Number.isFinite(props.min)
      ? props.min
      : (Number.isFinite(minVal) && minVal < 0 ? (Number.isFinite(minVal * 1.1) ? minVal * 1.1 : minVal) : 0);
    let resolvedMin = Number.isFinite(rawMin) ? rawMin : 0;

    let resolvedMax: number;
    if (typeof props.max === 'number' && Number.isFinite(props.max)) {
      resolvedMax = props.max;
    } else if (unit === '%' && (!Number.isFinite(maxVal) || maxVal <= 100)) {
      resolvedMax = 100;
    } else {
      let peak = Number.isFinite(maxVal) ? maxVal : 1;
      for (const t of thresholds) {
        if (t.value > peak) peak = t.value;
      }
      if (peak <= resolvedMin) {
        const padded = resolvedMin + (unit === 'ms' ? 10 : 1);
        resolvedMax = Number.isFinite(padded) ? padded : resolvedMin;
      } else {
        const paddedPeak = peak * 1.1;
        resolvedMax = Number.isFinite(paddedPeak) ? paddedPeak : peak;
      }
    }

    if (!Number.isFinite(resolvedMax - resolvedMin) || resolvedMax <= resolvedMin) {
      resolvedMin = 0;
      resolvedMax = 100;
    }

    return {
      startAt: resolvedStart,
      endAt: resolvedEnd,
      yMin: resolvedMin,
      yMax: resolvedMax,
      hasData: dataPoints > 0,
      primaryUnit: unit,
    };
  }, [series, thresholds, props.endAt, props.rangeMs, props.min, props.max]);

  const gapThresholdMs = useMemo(() => {
    const interval = typeof props.intervalMs === 'number' && Number.isFinite(props.intervalMs) && props.intervalMs > 0
      ? props.intervalMs
      : 5000;
    return Math.max(5000, interval * 2.5);
  }, [props.intervalMs]);

  const padLeft = showAxes ? 52 : (isSparkline ? 2 : 8);
  const padRight = showAxes ? 12 : (isSparkline ? 2 : 8);
  const padTop = isSparkline ? 3 : 10;
  const padBottom = showAxes ? 22 : (isSparkline ? 3 : 8);
  const svgHeight = Math.max(20, chartHeight - (showLegend ? 24 : 0));
  const plotWidth = Math.max(20, width - padLeft - padRight);
  const plotHeight = Math.max(12, svgHeight - padTop - padBottom);

  const seriesSegments = useMemo(() => (
    series.map((s) => ({
      series: s,
      segments: buildSegments(
        s.points,
        startAt,
        endAt,
        yMin,
        yMax,
        gapThresholdMs,
        padLeft,
        padTop,
        plotWidth,
        plotHeight,
      ),
    }))
  ), [series, startAt, endAt, yMin, yMax, gapThresholdMs, padLeft, padTop, plotWidth, plotHeight]);

  const hoverSnapshot = useMemo(() => {
    if (!interactive || hoverX === null || !hasData) return null;
    const ratio = Math.max(0, Math.min(1, (hoverX - padLeft) / plotWidth));
    const targetAt = startAt + ratio * (endAt - startAt);
    const tolerance = Math.max(gapThresholdMs, (endAt - startAt) * 0.04);

    let snappedAt: number | null = null;
    const values: Array<{ id: string; label: string; color: string; value: number | null; unit: PluginMetricChartUnit; x: number; y: number | null }> = [];
    const spanX = Math.max(1, endAt - startAt);
    const spanY = Math.max(1e-9, yMax - yMin);

    for (const s of series) {
      let closest: PluginMetricChartPoint | null = null;
      let bestDelta = tolerance;
      for (const pt of s.points) {
        if (pt.value === null || pt.at < startAt || pt.at > endAt) continue;
        const delta = Math.abs(pt.at - targetAt);
        if (delta <= bestDelta) {
          bestDelta = delta;
          closest = pt;
        }
      }
      if (closest && closest.value !== null) {
        if (snappedAt === null) snappedAt = closest.at;
        const rx = Math.max(0, Math.min(1, (closest.at - startAt) / spanX));
        const ry = (Math.max(yMin, Math.min(yMax, closest.value)) - yMin) / spanY;
        values.push({
          id: s.id,
          label: s.label,
          color: s.color,
          value: closest.value,
          unit: s.unit,
          x: padLeft + rx * plotWidth,
          y: padTop + plotHeight - ry * plotHeight,
        });
      } else {
        values.push({
          id: s.id,
          label: s.label,
          color: s.color,
          value: null,
          unit: s.unit,
          x: hoverX,
          y: null,
        });
      }
    }

    if (snappedAt === null) return null;
    const snappedX = padLeft + Math.max(0, Math.min(1, (snappedAt - startAt) / spanX)) * plotWidth;
    return { at: snappedAt, x: snappedX, values };
  }, [interactive, hoverX, hasData, padLeft, padTop, plotWidth, plotHeight, startAt, endAt, yMin, yMax, gapThresholdMs, series]);

  const handlePointerMove = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    if (!interactive) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    if (x >= padLeft && x <= padLeft + plotWidth) {
      setHoverX(x);
    } else {
      setHoverX(null);
    }
  }, [interactive, padLeft, plotWidth]);

  const handlePointerLeave = useCallback(() => {
    setHoverX(null);
  }, []);

  const yTicks = useMemo(() => {
    if (!showAxes) return [];
    const mid = yMin + (yMax - yMin) / 2;
    return [
      { value: yMax, y: padTop },
      { value: mid, y: padTop + plotHeight / 2 },
      { value: yMin, y: padTop + plotHeight },
    ];
  }, [showAxes, yMin, yMax, padTop, plotHeight]);

  const xTicks = useMemo(() => {
    if (!showAxes) return [];
    const mid = startAt + (endAt - startAt) / 2;
    return [
      { at: startAt, x: padLeft, anchor: 'start' as const },
      { at: mid, x: padLeft + plotWidth / 2, anchor: 'middle' as const },
      { at: endAt, x: padLeft + plotWidth, anchor: 'end' as const },
    ];
  }, [showAxes, startAt, endAt, padLeft, plotWidth]);

  const barItems = useMemo(() => {
    if (variant !== 'bar' || !hasData) return [];
    const timestamps = Array.from(
      new Set(
        series.flatMap((s) =>
          s.points
            .filter((p) => p.at >= startAt && p.at <= endAt && p.value !== null)
            .map((p) => p.at),
        ),
      ),
    ).sort((a, b) => a - b);
    const maxGroups = Math.min(timestamps.length, 48);
    const step = timestamps.length > maxGroups ? Math.ceil(timestamps.length / maxGroups) : 1;
    const sampledTs = timestamps.filter((_ts, i) => i % step === 0);
    if (sampledTs.length === 0) return [];
    const groupWidth = Math.max(4, plotWidth / sampledTs.length);
    const innerWidth = Math.max(2, (groupWidth * 0.78) / Math.max(1, series.length));
    const spanY = Math.max(1e-9, yMax - yMin);
    const bars: Array<{ key: string; x: number; y: number; w: number; h: number; color: string }> = [];

    sampledTs.forEach((ts, groupIdx) => {
      const groupStart = padLeft + groupIdx * groupWidth + groupWidth * 0.11;
      series.forEach((s, seriesIdx) => {
        const pt = s.points.find((candidate) => candidate.at === ts);
        if (!pt || pt.value === null) return;
        const clamped = Math.max(yMin, Math.min(yMax, pt.value));
        const barH = Math.max(1, ((clamped - yMin) / spanY) * plotHeight);
        bars.push({
          key: `${s.id}-${ts}`,
          x: groupStart + seriesIdx * innerWidth,
          y: padTop + plotHeight - barH,
          w: Math.max(1.5, innerWidth - 1),
          h: barH,
          color: s.color,
        });
      });
    });
    return bars;
  }, [variant, hasData, series, startAt, endAt, yMin, yMax, padLeft, padTop, plotWidth, plotHeight]);

  const tooltipLeft = hoverSnapshot
    ? (hoverSnapshot.x > width * 0.62 ? Math.max(4, hoverSnapshot.x - 168) : Math.max(4, Math.min(width - 164, hoverSnapshot.x + 10)))
    : 0;

  return (
    <div
      ref={containerRef}
      className="relative flex w-full flex-col select-none overflow-hidden text-foreground"
      style={{ height: `${chartHeight}px` }}
      role="img"
      aria-label={props.ariaLabel ?? series.map((s) => s.label).join(', ')}
    >
      {showLegend && (
        <div className="flex h-6 shrink-0 items-center justify-between gap-2 px-1 text-[11px] text-muted-foreground">
          <div className="flex min-w-0 items-center gap-3 overflow-hidden">
            {series.map((s) => (
              <span key={s.id} className="inline-flex min-w-0 items-center gap-1.5 truncate">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
                <span className="truncate">{s.label}</span>
                <span className="font-mono text-foreground">{formatMetricValue(s.latestValue, s.unit)}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <svg
          width={width}
          height={svgHeight}
          viewBox={`0 0 ${width} ${svgHeight}`}
          className="block h-full w-full overflow-visible"
          onPointerMove={interactive ? handlePointerMove : undefined}
          onPointerLeave={interactive ? handlePointerLeave : undefined}
        >
          <defs>
            {series.map((s, idx) => (
              <linearGradient key={s.id} id={`nc-mc-grad-${uid}-${idx}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity={isSparkline ? 0.28 : 0.24} />
                <stop offset="100%" stopColor={s.color} stopOpacity={0.01} />
              </linearGradient>
            ))}
          </defs>

          {showGrid && yTicks.map((tick, idx) => (
            <line
              key={`grid-${idx}`}
              x1={padLeft}
              y1={tick.y}
              x2={padLeft + plotWidth}
              y2={tick.y}
              stroke="hsl(var(--border))"
              strokeOpacity={0.55}
              strokeWidth={1}
              strokeDasharray={idx === yTicks.length - 1 ? undefined : '2 3'}
            />
          ))}

          {thresholds.map((t, idx) => {
            if (t.value < yMin || t.value > yMax) return null;
            const y = padTop + plotHeight - ((t.value - yMin) / Math.max(1e-9, yMax - yMin)) * plotHeight;
            const stroke = t.tone === 'critical' ? '#f43f5e' : '#f59e0b';
            return (
              <g key={`thr-${idx}`}>
                <line
                  x1={padLeft}
                  y1={y}
                  x2={padLeft + plotWidth}
                  y2={y}
                  stroke={stroke}
                  strokeOpacity={0.75}
                  strokeWidth={1}
                  strokeDasharray="4 3"
                />
                {t.label && !isSparkline && (
                  <text
                    x={padLeft + plotWidth - 2}
                    y={Math.max(padTop + 9, y - 3)}
                    textAnchor="end"
                    fontSize={9}
                    fill={stroke}
                  >
                    {t.label}
                  </text>
                )}
              </g>
            );
          })}

          {variant === 'bar' ? (
            barItems.map((bar) => (
              <rect
                key={bar.key}
                x={bar.x}
                y={bar.y}
                width={bar.w}
                height={bar.h}
                rx={1.5}
                fill={bar.color}
                fillOpacity={0.85}
              />
            ))
          ) : (
            seriesSegments.map(({ series: s, segments }, idx) => (
              <g key={s.id}>
                {(variant === 'area' || isSparkline) && segments.map((seg, segIdx) => (
                  seg.areaPath ? (
                    <path
                      key={`area-${segIdx}`}
                      d={seg.areaPath}
                      fill={`url(#nc-mc-grad-${uid}-${idx})`}
                    />
                  ) : null
                ))}
                {segments.map((seg, segIdx) => (
                  <path
                    key={`line-${segIdx}`}
                    d={seg.linePath}
                    fill="none"
                    stroke={s.color}
                    strokeWidth={isSparkline ? 1.5 : 1.75}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ))}
                {segments.length > 0 && !hoverSnapshot && (
                  <circle
                    cx={segments[segments.length - 1].lastX}
                    cy={segments[segments.length - 1].lastY}
                    r={isSparkline ? 2 : 2.5}
                    fill={s.color}
                  />
                )}
              </g>
            ))
          )}

          {showAxes && yTicks.map((tick, idx) => (
            <text
              key={`ytick-${idx}`}
              x={padLeft - 6}
              y={tick.y + 3}
              textAnchor="end"
              fontSize={10}
              fill="hsl(var(--muted-foreground))"
              className="font-mono"
            >
              {formatMetricValue(tick.value, primaryUnit)}
            </text>
          ))}

          {showAxes && xTicks.map((tick, idx) => (
            <text
              key={`xtick-${idx}`}
              x={tick.x}
              y={svgHeight - 5}
              textAnchor={tick.anchor}
              fontSize={10}
              fill="hsl(var(--muted-foreground))"
              className="font-mono"
            >
              {formatClockTime(tick.at)}
            </text>
          ))}

          {hoverSnapshot && (
            <g>
              <line
                x1={hoverSnapshot.x}
                y1={padTop}
                x2={hoverSnapshot.x}
                y2={padTop + plotHeight}
                stroke="hsl(var(--muted-foreground))"
                strokeOpacity={0.55}
                strokeWidth={1}
                strokeDasharray="2 2"
              />
              {hoverSnapshot.values.map((item) => (
                item.y !== null ? (
                  <circle
                    key={`dot-${item.id}`}
                    cx={item.x}
                    cy={item.y}
                    r={3.5}
                    fill={item.color}
                    stroke="hsl(var(--background))"
                    strokeWidth={1.5}
                  />
                ) : null
              ))}
            </g>
          )}
        </svg>

        {!hasData && !isSparkline && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
            {props.emptyText ?? 'Waiting for samples...'}
          </div>
        )}

        {hoverSnapshot && (
          <div
            className="pointer-events-none absolute top-1 z-10 min-w-[140px] max-w-[200px] rounded-md border border-border/80 bg-popover/95 px-2.5 py-1.5 text-[11px] text-popover-foreground shadow-md backdrop-blur-sm"
            style={{ left: `${tooltipLeft}px` }}
          >
            <div className="mb-1 font-mono text-[10px] text-muted-foreground">
              {formatClockTime(hoverSnapshot.at)}
            </div>
            <div className="space-y-0.5">
              {hoverSnapshot.values.map((item) => (
                <div key={item.id} className="flex items-center justify-between gap-2">
                  <span className="inline-flex min-w-0 items-center gap-1.5 truncate">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
                    <span className="truncate text-muted-foreground">{item.label}</span>
                  </span>
                  <span className="font-mono font-medium text-foreground">
                    {formatMetricValue(item.value, item.unit)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
