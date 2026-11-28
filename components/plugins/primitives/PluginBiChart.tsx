import { Download } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { matchWorkbenchShortcut } from './shortcuts';
import type {
  PluginBiChartActiveFilter,
  PluginBiChartColor,
  PluginBiChartPalette,
  PluginBiChartSeries,
  PluginBiChartType,
  PluginBiChartValueFormat,
  PluginBiChartWidgetProps,
  PluginWidgetEventCallback,
} from './types';

const MAX_SERIES = 12;
const MAX_CATEGORIES = 500;
const MAX_SCATTER_POINTS = 1500;
const MIN_HEIGHT = 160;
const MAX_HEIGHT = 640;
const DEFAULT_HEIGHT = 280;
const DEFAULT_WIDTH = 520;
const MAX_SVG_EVENT_BYTES = 180 * 1024;
const MAX_PNG_EVENT_BYTES = 160 * 1024;

const ALLOWED_TYPES = new Set<PluginBiChartType>([
  'bar',
  'horizontal-bar',
  'stacked-bar',
  'line',
  'area',
  'pie',
  'donut',
  'scatter',
  'funnel',
  'combo',
]);

const COLOR_MAP: Record<PluginBiChartColor, string> = {
  primary: 'hsl(var(--primary))',
  sky: '#0ea5e9',
  emerald: '#10b981',
  amber: '#f59e0b',
  violet: '#8b5cf6',
  rose: '#f43f5e',
  cyan: '#06b6d4',
  indigo: '#6366f1',
  teal: '#14b8a6',
  orange: '#f97316',
  slate: '#64748b',
  muted: 'hsl(var(--muted-foreground))',
};

const PALETTES: Record<PluginBiChartPalette, readonly PluginBiChartColor[]> = {
  default: ['primary', 'emerald', 'amber', 'violet', 'rose', 'cyan', 'indigo', 'teal', 'orange', 'sky', 'slate', 'muted'],
  categorical: ['sky', 'emerald', 'amber', 'rose', 'violet', 'teal', 'orange', 'indigo', 'cyan', 'primary', 'slate', 'muted'],
  cool: ['sky', 'cyan', 'teal', 'indigo', 'violet', 'emerald', 'primary', 'slate'],
  warm: ['amber', 'orange', 'rose', 'violet', 'emerald', 'sky', 'slate'],
  monochrome: ['primary', 'sky', 'indigo', 'slate', 'muted', 'cyan'],
};

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  CNY: '¥',
  JPY: '¥',
  KRW: '₩',
  INR: '₹',
};

function clampText(value: unknown, maxLen: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLen);
}

function truncateLabel(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

function resolveColor(
  explicit: PluginBiChartColor | undefined,
  palette: PluginBiChartPalette,
  index: number,
): string {
  if (explicit && Object.hasOwn(COLOR_MAP, explicit)) {
    return COLOR_MAP[explicit];
  }
  const cycle = PALETTES[palette] ?? PALETTES.default;
  return COLOR_MAP[cycle[index % cycle.length]];
}

export function formatBiValue(
  value: number | null | undefined,
  format: PluginBiChartValueFormat = 'compact',
  currency = 'USD',
): string {
  if (value == null || !Number.isFinite(value)) return '--';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';

  if (format === 'percent') {
    const pct = abs <= 1 && abs > 0 ? value * 100 : value;
    return `${pct.toFixed(Math.abs(pct) >= 100 || pct === 0 ? 0 : 1)}%`;
  }
  if (format === 'ms') {
    if (abs >= 1000) return `${(value / 1000).toFixed(2)} s`;
    return `${Math.round(value)} ms`;
  }
  if (format === 'bytes') {
    if (abs >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GiB`;
    if (abs >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
    if (abs >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
    return `${Math.round(value)} B`;
  }

  const compactStr = (num: number): string => {
    const a = Math.abs(num);
    const s = num < 0 ? '-' : '';
    if (a >= 1_000_000_000) return `${s}${(a / 1_000_000_000).toFixed(1)}B`;
    if (a >= 1_000_000) return `${s}${(a / 1_000_000).toFixed(1)}M`;
    if (a >= 10_000) return `${s}${(a / 1_000).toFixed(1)}K`;
    if (a >= 1_000) return `${s}${(a / 1_000).toFixed(2).replace(/\.?0+$/, '')}K`;
    if (Number.isInteger(num)) return String(num);
    return a >= 100 ? num.toFixed(0) : num.toFixed(2).replace(/\.?0+$/, '');
  };

  if (format === 'currency') {
    const iso = typeof currency === 'string' && /^[A-Z]{3}$/.test(currency) ? currency : 'USD';
    const sym = CURRENCY_SYMBOLS[iso] ?? `${iso} `;
    return `${sign}${sym}${compactStr(abs)}`;
  }

  if (format === 'number') {
    if (Number.isInteger(value)) return value.toLocaleString('en-US');
    return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  return compactStr(value);
}

function niceDomain(minVal: number, maxVal: number, includeZero = true): { min: number; max: number; ticks: number[] } {
  let lo = includeZero ? Math.min(0, minVal) : minVal;
  let hi = includeZero ? Math.max(0, maxVal) : maxVal;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    return { min: 0, max: 100, ticks: [0, 25, 50, 75, 100] };
  }
  if (lo === hi) {
    if (hi === 0) {
      hi = 100;
    } else if (hi > 0) {
      lo = includeZero ? 0 : hi * 0.8;
      hi = hi * 1.2;
    } else {
      lo = lo * 1.2;
      hi = includeZero ? 0 : hi * 0.8;
    }
  }
  const span = hi - lo;
  const rawStep = span / 4;
  const mag = 10 ** Math.floor(Math.log10(Math.max(rawStep, 1e-9)));
  const norm = rawStep / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const niceMin = Math.floor(lo / step) * step;
  const niceMax = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = niceMin; v <= niceMax + step * 0.001 && ticks.length < 8; v += step) {
    ticks.push(Math.abs(v) < 1e-10 ? 0 : Number(v.toPrecision(10)));
  }
  return { min: niceMin, max: niceMax, ticks };
}

function buildLinePath(pts: Array<{ x: number; y: number }>, smooth: boolean): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  if (!smooth || pts.length < 3) {
    return pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  }
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

interface CleanScatterPoint {
  x: number;
  y: number;
  label: string;
  size: number;
}

interface CleanSeries {
  index: number;
  id: string;
  name: string;
  color: string;
  data: Array<number | null>;
  points: CleanScatterPoint[];
  renderAs: 'bar' | 'line' | 'area';
  yAxis: 'left' | 'right';
  format: PluginBiChartValueFormat;
  currency: string;
}

interface HoverTooltipState {
  x: number;
  y: number;
  title: string;
  rows: Array<{ color: string; name: string; value: string; share?: string }>;
}

function sanitizeSeries(
  rawSeries: PluginBiChartSeries[] | undefined,
  palette: PluginBiChartPalette,
  defaultFormat: PluginBiChartValueFormat,
  defaultCurrency: string,
): CleanSeries[] {
  if (!Array.isArray(rawSeries)) return [];
  return rawSeries
    .slice(0, MAX_SERIES)
    .filter((s): s is PluginBiChartSeries => Boolean(s && typeof s === 'object'))
    .map((s, idx) => {
      const data = Array.isArray(s.data)
        ? s.data.slice(0, MAX_CATEGORIES).map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null))
        : [];
      const points: CleanScatterPoint[] = [];
      if (Array.isArray(s.points)) {
        for (const pt of s.points.slice(0, MAX_SCATTER_POINTS)) {
          if (!pt || typeof pt !== 'object') continue;
          if (typeof pt.x !== 'number' || !Number.isFinite(pt.x) || typeof pt.y !== 'number' || !Number.isFinite(pt.y)) continue;
          const rawSize = typeof pt.size === 'number' && Number.isFinite(pt.size) ? pt.size : 5;
          points.push({
            x: pt.x,
            y: pt.y,
            label: clampText(pt.label, 80),
            size: Math.max(3, Math.min(14, rawSize)),
          });
        }
      }
      const renderAs: 'bar' | 'line' | 'area' =
        s.renderAs === 'bar' || s.renderAs === 'line' || s.renderAs === 'area'
          ? s.renderAs
          : idx === 0
            ? 'bar'
            : 'line';
      const yAxis: 'left' | 'right' = s.yAxis === 'right' ? 'right' : 'left';
      return {
        index: idx,
        id: clampText(s.id, 80) || `series-${idx}`,
        name: clampText(s.name, 80) || `Series ${idx + 1}`,
        color: resolveColor(s.color, palette, idx),
        data,
        points,
        renderAs,
        yAxis,
        format: s.format ?? defaultFormat,
        currency: s.currency ?? defaultCurrency,
      };
    });
}

function isDatumMatched(
  filter: PluginBiChartActiveFilter | null | undefined,
  seriesIndex: number,
  datumIndex: number,
  category: string,
): boolean {
  if (!filter) return true;
  if (filter.seriesIndex !== undefined && filter.seriesIndex !== seriesIndex) return false;
  if (filter.datumIndex !== undefined && filter.datumIndex !== datumIndex) return false;
  if (filter.category !== undefined && filter.category !== category) return false;
  return true;
}

function resolveThemeColors(el: HTMLElement | null) {
  const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  const readVar = (name: string, fallback: string) => {
    if (!el || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return fallback;
    const raw = window.getComputedStyle(el).getPropertyValue(name).trim();
    return raw ? `hsl(${raw})` : fallback;
  };
  return {
    background: readVar('--card', readVar('--background', isDark ? '#14171f' : '#ffffff')),
    foreground: readVar('--foreground', isDark ? '#f1f5f9' : '#0f172a'),
    mutedForeground: readVar('--muted-foreground', isDark ? '#94a3b8' : '#64748b'),
    border: readVar('--border', isDark ? '#272c3a' : '#e2e8f0'),
    primary: readVar('--primary', isDark ? '#38bdf8' : '#2563eb'),
  };
}

function buildResolvedSvgString(svgEl: SVGSVGElement, containerEl: HTMLElement | null): string {
  const theme = resolveThemeColors(containerEl);
  const clone = svgEl.cloneNode(true) as SVGSVGElement;
  const width = Number(svgEl.getAttribute('width')) || svgEl.getBoundingClientRect().width || DEFAULT_WIDTH;
  const height = Number(svgEl.getAttribute('height')) || svgEl.getBoundingClientRect().height || DEFAULT_HEIGHT;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(Math.round(width)));
  clone.setAttribute('height', String(Math.round(height)));

  // Insert solid background rect first so exported SVG/PNG has crisp theme contrast.
  const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bgRect.setAttribute('width', '100%');
  bgRect.setAttribute('height', '100%');
  bgRect.setAttribute('fill', theme.background);
  clone.insertBefore(bgRect, clone.firstChild);

  const serializer = new XMLSerializer();
  return serializer
    .serializeToString(clone)
    .replace(/hsl\(var\(--primary\)\)/g, theme.primary)
    .replace(/hsl\(var\(--foreground\)\)/g, theme.foreground)
    .replace(/hsl\(var\(--muted-foreground\)\)/g, theme.mutedForeground)
    .replace(/hsl\(var\(--border\)\)/g, theme.border)
    .replace(/hsl\(var\(--card\)\)/g, theme.background)
    .replace(/hsl\(var\(--background\)\)/g, theme.background);
}

function triggerBrowserDownload(blob: Blob, filename: string): boolean {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function' || typeof document === 'undefined') {
    return false;
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

function sanitizeFileSlug(title: string, type: PluginBiChartType): string {
  const base = (title || `bi-${type}`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || `bi-${type}`;
}

export interface PluginBiChartProps extends PluginBiChartWidgetProps {
  onWidgetEvent: PluginWidgetEventCallback;
}

export function PluginBiChart({
  type: rawType = 'bar',
  title: rawTitle,
  subtitle: rawSubtitle,
  categories: rawCategories,
  series: rawSeries,
  palette: rawPalette = 'default',
  xAxisLabel: rawXAxisLabel,
  yAxisLabel: rawYAxisLabel,
  yAxisRightLabel: rawYAxisRightLabel,
  valueFormat = 'compact',
  currency = 'USD',
  height: rawHeight = DEFAULT_HEIGHT,
  showGrid = true,
  showLegend = true,
  showDataLabels = false,
  smooth = false,
  donutInnerRatio: rawDonutInnerRatio = 0.62,
  exportable = true,
  activeFilter = null,
  emptyText = 'No data available',
  ariaLabel,
  onWidgetEvent,
}: PluginBiChartProps) {
  const chartType: PluginBiChartType = ALLOWED_TYPES.has(rawType) ? rawType : 'bar';
  const palette: PluginBiChartPalette = Object.hasOwn(PALETTES, rawPalette) ? rawPalette : 'default';
  const title = clampText(rawTitle, 120);
  const subtitle = clampText(rawSubtitle, 200);
  const xAxisLabel = clampText(rawXAxisLabel, 80);
  const yAxisLabel = clampText(rawYAxisLabel, 80);
  const yAxisRightLabel = clampText(rawYAxisRightLabel, 80);
  const chartHeight = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Number.isFinite(rawHeight) ? Math.round(rawHeight) : DEFAULT_HEIGHT));
  const donutInnerRatio = Math.max(0.45, Math.min(0.75, Number.isFinite(rawDonutInnerRatio) ? rawDonutInnerRatio : 0.62));

  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [hiddenSeriesIds, setHiddenSeriesIds] = useState<Set<string>>(() => new Set());
  const [tooltip, setTooltip] = useState<HoverTooltipState | null>(null);
  const [hoveredCatIndex, setHoveredCatIndex] = useState<number | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const next = Math.round(el.getBoundingClientRect().width);
      if (next > 80) setWidth(next);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const allSeries = useMemo(
    () => sanitizeSeries(rawSeries, palette, valueFormat, currency),
    [rawSeries, palette, valueFormat, currency],
  );

  // Drop stale hidden IDs when series change.
  useEffect(() => {
    const validIds = new Set(allSeries.map((s) => s.id));
    setHiddenSeriesIds((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (validIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [allSeries]);

  const visibleSeries = useMemo(
    () => allSeries.filter((s) => !hiddenSeriesIds.has(s.id)),
    [allSeries, hiddenSeriesIds],
  );

  const categories = useMemo(() => {
    if (Array.isArray(rawCategories) && rawCategories.length > 0) {
      return rawCategories.slice(0, MAX_CATEGORIES).map((c, idx) => clampText(String(c ?? ''), 120) || `#${idx + 1}`);
    }
    const maxLen = allSeries.reduce((acc, s) => Math.max(acc, s.data.length), 0);
    return Array.from({ length: maxLen }, (_, i) => `#${i + 1}`);
  }, [rawCategories, allSeries]);

  const hasData = useMemo(() => {
    if (chartType === 'scatter') {
      return visibleSeries.some((s) => s.points.length > 0);
    }
    return categories.length > 0 && visibleSeries.some((s) => s.data.some((v) => v !== null));
  }, [chartType, categories.length, visibleSeries]);

  const toggleSeries = useCallback((id: string) => {
    setHiddenSeriesIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const emitDatumClick = useCallback(
    (payload: {
      seriesIndex: number;
      seriesName: string;
      datumIndex: number;
      category: string;
      value: number | null;
      x?: number;
      y?: number;
    }) => {
      onWidgetEvent('datumClick', payload);
    },
    [onWidgetEvent],
  );

  const handleExportSvg = useCallback(() => {
    if (!svgRef.current) return;
    const svg = buildResolvedSvgString(svgRef.current, containerRef.current);
    const suggestedName = `${sanitizeFileSlug(title, chartType)}.svg`;
    if (svg.length <= MAX_SVG_EVENT_BYTES) {
      onWidgetEvent('exportSvg', { svg, suggestedName });
      return;
    }
    const downloaded = triggerBrowserDownload(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), suggestedName);
    onWidgetEvent('exportSvg', { svg: '', suggestedName, downloadedByHost: downloaded });
  }, [title, chartType, onWidgetEvent]);

  const handleExportPng = useCallback(() => {
    if (!svgRef.current) return;
    const svg = buildResolvedSvgString(svgRef.current, containerRef.current);
    const suggestedName = `${sanitizeFileSlug(title, chartType)}.png`;
    const theme = resolveThemeColors(containerRef.current);
    const svgW = Number(svgRef.current.getAttribute('width')) || width;
    const svgH = Number(svgRef.current.getAttribute('height')) || chartHeight;
    const scale = 2;

    if (typeof Image === 'undefined' || typeof document === 'undefined') {
      onWidgetEvent('exportPng', { suggestedName, downloadedByHost: false });
      return;
    }

    const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(svgW * scale);
        canvas.height = Math.round(svgH * scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          onWidgetEvent('exportPng', { suggestedName, downloadedByHost: false });
          return;
        }
        ctx.scale(scale, scale);
        ctx.fillStyle = theme.background;
        ctx.fillRect(0, 0, svgW, svgH);
        ctx.drawImage(img, 0, 0, svgW, svgH);
        const dataUrl = canvas.toDataURL('image/png');
        let downloaded = false;
        if (typeof canvas.toBlob === 'function') {
          canvas.toBlob((pngBlob) => {
            if (pngBlob) downloaded = triggerBrowserDownload(pngBlob, suggestedName);
            onWidgetEvent('exportPng', {
              suggestedName,
              downloadedByHost: downloaded,
              ...(dataUrl.length <= MAX_PNG_EVENT_BYTES ? { dataUrl } : {}),
            });
          }, 'image/png');
        } else {
          onWidgetEvent('exportPng', {
            suggestedName,
            downloadedByHost: false,
            ...(dataUrl.length <= MAX_PNG_EVENT_BYTES ? { dataUrl } : {}),
          });
        }
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      onWidgetEvent('exportPng', { suggestedName, downloadedByHost: false });
    };
    img.src = url;
  }, [title, chartType, width, chartHeight, onWidgetEvent]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const shortcut = matchWorkbenchShortcut(event, { includeUndoRedo: true });
      if (!shortcut) return;
      if (shortcut !== 'escape') event.preventDefault();
      event.stopPropagation();
      onWidgetEvent('shortcut', { shortcut });
    },
    [onWidgetEvent],
  );

  const svgWidth = Math.max(240, width - 2);
  const svgHeight = chartHeight;

  const renderCartesianBody = () => {
    const isHorizontal = chartType === 'horizontal-bar';
    const isStacked = chartType === 'stacked-bar';
    const isCombo = chartType === 'combo';
    const hasRightAxis = isCombo && visibleSeries.some((s) => s.yAxis === 'right');

    const padLeft = isHorizontal ? Math.min(148, Math.max(84, Math.round(svgWidth * 0.24))) : yAxisLabel ? 64 : 52;
    const padRight = hasRightAxis ? (yAxisRightLabel ? 64 : 52) : 16;
    const padTop = 14;
    const rotateX = !isHorizontal && categories.length > Math.max(6, Math.floor((svgWidth - padLeft - padRight) / 62));
    const padBottom = isHorizontal ? (xAxisLabel ? 36 : 24) : rotateX ? (xAxisLabel ? 68 : 54) : xAxisLabel ? 44 : 30;
    const plotW = Math.max(80, svgWidth - padLeft - padRight);
    const plotH = Math.max(60, svgHeight - padTop - padBottom);

    // Compute domains
    let leftMin = 0;
    let leftMax = 0;
    let rightMin = 0;
    let rightMax = 0;

    if (isStacked) {
      for (let i = 0; i < categories.length; i++) {
        let posSum = 0;
        let negSum = 0;
        for (const s of visibleSeries) {
          const v = s.data[i];
          if (v == null) continue;
          if (v >= 0) posSum += v;
          else negSum += v;
        }
        if (posSum > leftMax) leftMax = posSum;
        if (negSum < leftMin) leftMin = negSum;
      }
    } else {
      for (const s of visibleSeries) {
        const useRight = isCombo && s.yAxis === 'right';
        for (const v of s.data) {
          if (v == null) continue;
          if (useRight) {
            if (v > rightMax) rightMax = v;
            if (v < rightMin) rightMin = v;
          } else {
            if (v > leftMax) leftMax = v;
            if (v < leftMin) leftMin = v;
          }
        }
      }
    }

    const leftDomain = niceDomain(leftMin, leftMax, true);
    const rightDomain = hasRightAxis ? niceDomain(rightMin, rightMax, true) : null;
    const leftFormat = visibleSeries.find((s) => s.yAxis !== 'right')?.format ?? valueFormat;
    const leftCurrency = visibleSeries.find((s) => s.yAxis !== 'right')?.currency ?? currency;
    const rightFormat = visibleSeries.find((s) => s.yAxis === 'right')?.format ?? valueFormat;
    const rightCurrency = visibleSeries.find((s) => s.yAxis === 'right')?.currency ?? currency;

    const scaleLeftY = (v: number) =>
      padTop + plotH - ((v - leftDomain.min) / Math.max(1e-9, leftDomain.max - leftDomain.min)) * plotH;
    const scaleRightY = (v: number) =>
      rightDomain
        ? padTop + plotH - ((v - rightDomain.min) / Math.max(1e-9, rightDomain.max - rightDomain.min)) * plotH
        : scaleLeftY(v);
    const scaleHorizX = (v: number) =>
      padLeft + ((v - leftDomain.min) / Math.max(1e-9, leftDomain.max - leftDomain.min)) * plotW;

    if (isHorizontal) {
      const catCount = Math.max(1, categories.length);
      const bandH = plotH / catCount;
      const barGroupH = Math.min(bandH * 0.72, 34);
      const barH = Math.max(4, barGroupH / Math.max(1, visibleSeries.length));
      const zeroX = scaleHorizX(0);

      return (
        <>
          {showGrid &&
            leftDomain.ticks.map((tick) => {
              const x = scaleHorizX(tick);
              return (
                <g key={`gx-${tick}`}>
                  <line x1={x} y1={padTop} x2={x} y2={padTop + plotH} stroke="hsl(var(--border))" strokeWidth={1} strokeDasharray={tick === 0 ? undefined : '2 3'} opacity={tick === 0 ? 0.9 : 0.6} />
                  <text x={x} y={padTop + plotH + 14} textAnchor="middle" fontSize={10} fill="hsl(var(--muted-foreground))" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {formatBiValue(tick, leftFormat, leftCurrency)}
                  </text>
                </g>
              );
            })}

          {categories.map((cat, ci) => {
            const cy = padTop + (ci + 0.5) * bandH;
            const groupTop = cy - (barH * visibleSeries.length) / 2;
            const labelStep = Math.max(1, Math.ceil(catCount / Math.floor(plotH / 18)));
            return (
              <g key={`hrow-${ci}`}>
                {ci % labelStep === 0 && (
                  <text x={padLeft - 8} y={cy + 3.5} textAnchor="end" fontSize={10.5} fill="hsl(var(--muted-foreground))">
                    {truncateLabel(cat, Math.max(8, Math.floor((padLeft - 14) / 6.5)))}
                  </text>
                )}
                {visibleSeries.map((s, si) => {
                  const val = s.data[ci];
                  if (val == null) return null;
                  const xVal = scaleHorizX(val);
                  const rectX = Math.min(zeroX, xVal);
                  const rectW = Math.max(1.5, Math.abs(xVal - zeroX));
                  const rectY = groupTop + si * barH;
                  const matched = isDatumMatched(activeFilter, s.index, ci, cat);
                  return (
                    <g key={`hbar-${s.id}-${ci}`}>
                      <rect
                        data-bi-datum={`${s.index}:${ci}`}
                        x={rectX}
                        y={rectY}
                        width={rectW}
                        height={Math.max(3, barH - 1.5)}
                        rx={1.5}
                        fill={s.color}
                        opacity={matched ? (hoveredCatIndex === ci ? 1 : 0.88) : 0.28}
                        className="cursor-pointer transition-opacity duration-100"
                        onMouseEnter={() => {
                          setHoveredCatIndex(ci);
                          setTooltip({
                            x: Math.min(svgWidth - 160, rectX + rectW + 8),
                            y: Math.max(8, rectY - 6),
                            title: cat,
                            rows: visibleSeries
                              .filter((item) => item.data[ci] != null)
                              .map((item) => ({
                                color: item.color,
                                name: item.name,
                                value: formatBiValue(item.data[ci], item.format, item.currency),
                              })),
                          });
                        }}
                        onMouseLeave={() => {
                          setHoveredCatIndex(null);
                          setTooltip(null);
                        }}
                        onClick={() => emitDatumClick({ seriesIndex: s.index, seriesName: s.name, datumIndex: ci, category: cat, value: val })}
                      />
                      {showDataLabels && rectW > 24 && (
                        <text x={rectX + rectW + 5} y={rectY + barH / 2 + 3} fontSize={9.5} fill="hsl(var(--muted-foreground))" style={{ fontVariantNumeric: 'tabular-nums' }}>
                          {formatBiValue(val, s.format, s.currency)}
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            );
          })}
          {xAxisLabel && (
            <text x={padLeft + plotW / 2} y={svgHeight - 4} textAnchor="middle" fontSize={10} fill="hsl(var(--muted-foreground))">
              {xAxisLabel}
            </text>
          )}
        </>
      );
    }

    // Vertical cartesian charts: bar, stacked-bar, line, area, combo
    const catCount = Math.max(1, categories.length);
    const bandW = plotW / catCount;
    const xCenter = (ci: number) =>
      (chartType === 'line' || chartType === 'area') && catCount > 1
        ? padLeft + (ci / (catCount - 1)) * plotW
        : padLeft + (ci + 0.5) * bandW;
    const maxTicksX = Math.max(2, Math.floor(plotW / (rotateX ? 34 : 68)));
    const tickStepX = Math.max(1, Math.ceil(catCount / maxTicksX));
    const zeroLeftY = scaleLeftY(0);

    const barSeries = isCombo
      ? visibleSeries.filter((s) => s.renderAs === 'bar')
      : chartType === 'bar' || chartType === 'stacked-bar'
        ? visibleSeries
        : [];
    const lineSeries = isCombo
      ? visibleSeries.filter((s) => s.renderAs !== 'bar')
      : chartType === 'line' || chartType === 'area'
        ? visibleSeries
        : [];

    const groupW = Math.min(bandW * 0.72, isStacked ? 48 : 64);
    const singleBarW = isStacked ? groupW : Math.max(3, groupW / Math.max(1, barSeries.length) - 1.5);

    const showCatTooltip = (ci: number) => {
      const cat = categories[ci];
      const total = isStacked
        ? visibleSeries.reduce((acc, s) => acc + Math.max(0, s.data[ci] ?? 0), 0)
        : 0;
      const cx = xCenter(ci);
      setHoveredCatIndex(ci);
      setTooltip({
        x: cx > svgWidth * 0.62 ? Math.max(8, cx - 178) : Math.min(svgWidth - 178, cx + 12),
        y: padTop + 8,
        title: cat,
        rows: visibleSeries
          .filter((s) => s.data[ci] != null)
          .map((s) => {
            const val = s.data[ci]!;
            const share = isStacked && total > 0 ? `${((Math.max(0, val) / total) * 100).toFixed(1)}%` : undefined;
            return {
              color: s.color,
              name: s.name,
              value: formatBiValue(val, s.format, s.currency),
              share,
            };
          }),
      });
    };

    return (
      <>
        {/* Horizontal grid & Left Y-axis ticks */}
        {leftDomain.ticks.map((tick) => {
          const y = scaleLeftY(tick);
          return (
            <g key={`gy-l-${tick}`}>
              {showGrid && (
                <line
                  x1={padLeft}
                  y1={y}
                  x2={padLeft + plotW}
                  y2={y}
                  stroke="hsl(var(--border))"
                  strokeWidth={1}
                  strokeDasharray={tick === 0 ? undefined : '2 3'}
                  opacity={tick === 0 ? 0.9 : 0.55}
                />
              )}
              <text x={padLeft - 7} y={y + 3.5} textAnchor="end" fontSize={10} fill="hsl(var(--muted-foreground))" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {formatBiValue(tick, leftFormat, leftCurrency)}
              </text>
            </g>
          );
        })}

        {/* Right Y-axis ticks (combo dual axis) */}
        {rightDomain &&
          rightDomain.ticks.map((tick) => {
            const y = scaleRightY(tick);
            return (
              <text key={`gy-r-${tick}`} x={padLeft + plotW + 7} y={y + 3.5} textAnchor="start" fontSize={10} fill="hsl(var(--muted-foreground))" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {formatBiValue(tick, rightFormat, rightCurrency)}
              </text>
            );
          })}

        {/* Hover vertical guideline */}
        {hoveredCatIndex !== null && hoveredCatIndex < categories.length && (
          <line
            x1={xCenter(hoveredCatIndex)}
            y1={padTop}
            x2={xCenter(hoveredCatIndex)}
            y2={padTop + plotH}
            stroke="hsl(var(--muted-foreground))"
            strokeWidth={1}
            strokeDasharray="2 2"
            opacity={0.45}
          />
        )}

        {/* Bar layers */}
        {barSeries.length > 0 &&
          categories.map((cat, ci) => {
            const cx = xCenter(ci);
            if (isStacked) {
              let posAcc = 0;
              let negAcc = 0;
              return (
                <g key={`sbar-${ci}`}>
                  {barSeries.map((s) => {
                    const val = s.data[ci];
                    if (val == null) return null;
                    const yStart = val >= 0 ? scaleLeftY(posAcc) : scaleLeftY(negAcc);
                    if (val >= 0) posAcc += val;
                    else negAcc += val;
                    const yEnd = val >= 0 ? scaleLeftY(posAcc) : scaleLeftY(negAcc);
                    const rectY = Math.min(yStart, yEnd);
                    const rectH = Math.max(1.5, Math.abs(yEnd - yStart));
                    const matched = isDatumMatched(activeFilter, s.index, ci, cat);
                    return (
                      <rect
                        key={`sb-${s.id}-${ci}`}
                        data-bi-datum={`${s.index}:${ci}`}
                        x={cx - singleBarW / 2}
                        y={rectY}
                        width={singleBarW}
                        height={rectH}
                        fill={s.color}
                        opacity={matched ? (hoveredCatIndex === ci ? 1 : 0.88) : 0.28}
                        className="cursor-pointer transition-opacity duration-100"
                        onMouseEnter={() => showCatTooltip(ci)}
                        onMouseLeave={() => {
                          setHoveredCatIndex(null);
                          setTooltip(null);
                        }}
                        onClick={() => emitDatumClick({ seriesIndex: s.index, seriesName: s.name, datumIndex: ci, category: cat, value: val })}
                      />
                    );
                  })}
                </g>
              );
            }

            const totalW = barSeries.length * (singleBarW + 1.5) - 1.5;
            const startX = cx - totalW / 2;
            return (
              <g key={`gbar-${ci}`}>
                {barSeries.map((s, bi) => {
                  const val = s.data[ci];
                  if (val == null) return null;
                  const useRight = isCombo && s.yAxis === 'right';
                  const yVal = useRight ? scaleRightY(val) : scaleLeftY(val);
                  const yZero = useRight && rightDomain ? scaleRightY(0) : zeroLeftY;
                  const rectY = Math.min(yVal, yZero);
                  const rectH = Math.max(1.5, Math.abs(yVal - yZero));
                  const rectX = startX + bi * (singleBarW + 1.5);
                  const matched = isDatumMatched(activeFilter, s.index, ci, cat);
                  return (
                    <g key={`gb-${s.id}-${ci}`}>
                      <rect
                        data-bi-datum={`${s.index}:${ci}`}
                        x={rectX}
                        y={rectY}
                        width={singleBarW}
                        height={rectH}
                        rx={1.5}
                        fill={s.color}
                        opacity={matched ? (hoveredCatIndex === ci ? 1 : 0.88) : 0.28}
                        className="cursor-pointer transition-opacity duration-100"
                        onMouseEnter={() => showCatTooltip(ci)}
                        onMouseLeave={() => {
                          setHoveredCatIndex(null);
                          setTooltip(null);
                        }}
                        onClick={() => emitDatumClick({ seriesIndex: s.index, seriesName: s.name, datumIndex: ci, category: cat, value: val })}
                      />
                      {showDataLabels && singleBarW >= 18 && (
                        <text x={rectX + singleBarW / 2} y={Math.max(padTop + 10, rectY - 4)} textAnchor="middle" fontSize={9.5} fill="hsl(var(--muted-foreground))" style={{ fontVariantNumeric: 'tabular-nums' }}>
                          {formatBiValue(val, s.format, s.currency)}
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            );
          })}

        {/* Line & Area layers */}
        {lineSeries.map((s) => {
          const useRight = isCombo && s.yAxis === 'right';
          const yScale = useRight ? scaleRightY : scaleLeftY;
          const yZero = useRight && rightDomain ? scaleRightY(0) : zeroLeftY;
          const isArea = chartType === 'area' || (isCombo && s.renderAs === 'area');

          const segments: Array<Array<{ x: number; y: number; ci: number; val: number }>> = [];
          let current: Array<{ x: number; y: number; ci: number; val: number }> = [];
          for (let ci = 0; ci < categories.length; ci++) {
            const val = s.data[ci];
            if (val == null) {
              if (current.length > 0) {
                segments.push(current);
                current = [];
              }
            } else {
              current.push({ x: xCenter(ci), y: yScale(val), ci, val });
            }
          }
          if (current.length > 0) segments.push(current);

          return (
            <g key={`line-${s.id}`}>
              {segments.map((seg, segIdx) => {
                const lineD = buildLinePath(seg, smooth);
                const areaD =
                  isArea && seg.length > 1
                    ? `${lineD} L ${seg[seg.length - 1].x.toFixed(1)} ${yZero.toFixed(1)} L ${seg[0].x.toFixed(1)} ${yZero.toFixed(1)} Z`
                    : '';
                return (
                  <g key={`seg-${s.id}-${segIdx}`}>
                    {areaD && <path d={areaD} fill={s.color} opacity={0.14} />}
                    <path d={lineD} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                  </g>
                );
              })}
              {segments.flat().map((pt) => {
                const cat = categories[pt.ci];
                const matched = isDatumMatched(activeFilter, s.index, pt.ci, cat);
                const showMarker = hoveredCatIndex === pt.ci || categories.length <= 24 || !matched;
                return (
                  <g key={`pt-${s.id}-${pt.ci}`}>
                    <circle
                      data-bi-datum={`${s.index}:${pt.ci}`}
                      cx={pt.x}
                      cy={pt.y}
                      r={hoveredCatIndex === pt.ci ? 4.5 : showMarker ? 3 : 2}
                      fill={s.color}
                      stroke="hsl(var(--card))"
                      strokeWidth={1.5}
                      opacity={matched ? (showMarker ? 1 : 0.01) : 0.25}
                      className="cursor-pointer"
                      onMouseEnter={() => showCatTooltip(pt.ci)}
                      onMouseLeave={() => {
                        setHoveredCatIndex(null);
                        setTooltip(null);
                      }}
                      onClick={() => emitDatumClick({ seriesIndex: s.index, seriesName: s.name, datumIndex: pt.ci, category: cat, value: pt.val })}
                    />
                    {showDataLabels && categories.length <= 16 && (
                      <text x={pt.x} y={Math.max(padTop + 10, pt.y - 7)} textAnchor="middle" fontSize={9.5} fill="hsl(var(--muted-foreground))" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {formatBiValue(pt.val, s.format, s.currency)}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}

        {/* X-axis tick labels */}
        {categories.map((cat, ci) => {
          if (ci % tickStepX !== 0 && ci !== categories.length - 1) return null;
          const x = xCenter(ci);
          const y = padTop + plotH + 14;
          const label = truncateLabel(cat, rotateX ? 14 : 16);
          return rotateX ? (
            <text
              key={`xt-${ci}`}
              x={x}
              y={y}
              textAnchor="end"
              fontSize={10}
              fill="hsl(var(--muted-foreground))"
              transform={`rotate(-35 ${x} ${y})`}
            >
              {label}
            </text>
          ) : (
            <text key={`xt-${ci}`} x={x} y={y} textAnchor="middle" fontSize={10} fill="hsl(var(--muted-foreground))">
              {label}
            </text>
          );
        })}

        {/* Axis labels */}
        {xAxisLabel && (
          <text x={padLeft + plotW / 2} y={svgHeight - 4} textAnchor="middle" fontSize={10} fill="hsl(var(--muted-foreground))">
            {xAxisLabel}
          </text>
        )}
        {yAxisLabel && (
          <text x={14} y={padTop + plotH / 2} textAnchor="middle" fontSize={10} fill="hsl(var(--muted-foreground))" transform={`rotate(-90 14 ${padTop + plotH / 2})`}>
            {yAxisLabel}
          </text>
        )}
        {hasRightAxis && yAxisRightLabel && (
          <text
            x={svgWidth - 12}
            y={padTop + plotH / 2}
            textAnchor="middle"
            fontSize={10}
            fill="hsl(var(--muted-foreground))"
            transform={`rotate(90 ${svgWidth - 12} ${padTop + plotH / 2})`}
          >
            {yAxisRightLabel}
          </text>
        )}
      </>
    );
  };

  const renderPieOrDonut = () => {
    const primary = visibleSeries[0];
    if (!primary) return null;
    const slices = categories
      .map((cat, idx) => ({
        index: idx,
        category: cat,
        value: primary.data[idx] ?? 0,
        color: resolveColor(undefined, palette, idx),
      }))
      .filter((s) => Number.isFinite(s.value) && s.value > 0);

    const total = slices.reduce((acc, s) => acc + s.value, 0);
    if (total <= 0) return null;

    const showSideList = svgWidth >= 380;
    const cx = showSideList ? svgWidth * 0.34 : svgWidth * 0.5;
    const cy = svgHeight * 0.5;
    const outerR = Math.max(36, Math.min(cx - 24, cy - 20, 128));
    const innerR = chartType === 'donut' ? outerR * donutInnerRatio : 0;

    let angle = -Math.PI / 2;
    const arcs = slices.map((slice) => {
      const sweep = (slice.value / total) * Math.PI * 2;
      const startAngle = angle;
      const endAngle = angle + sweep;
      const midAngle = startAngle + sweep / 2;
      angle = endAngle;

      // Full-circle edge case (single slice)
      const full = sweep >= Math.PI * 2 - 1e-4;
      let path = '';
      if (full) {
        const endSafe = startAngle + Math.PI * 1.999;
        const x1 = cx + Math.cos(startAngle) * outerR;
        const y1 = cy + Math.sin(startAngle) * outerR;
        const x2 = cx + Math.cos(endSafe) * outerR;
        const y2 = cy + Math.sin(endSafe) * outerR;
        if (innerR > 0) {
          const ix1 = cx + Math.cos(endSafe) * innerR;
          const iy1 = cy + Math.sin(endSafe) * innerR;
          const ix2 = cx + Math.cos(startAngle) * innerR;
          const iy2 = cy + Math.sin(startAngle) * innerR;
          path = `M ${x1} ${y1} A ${outerR} ${outerR} 0 1 1 ${x2} ${y2} L ${ix1} ${iy1} A ${innerR} ${innerR} 0 1 0 ${ix2} ${iy2} Z`;
        } else {
          path = `M ${cx} ${cy} L ${x1} ${y1} A ${outerR} ${outerR} 0 1 1 ${x2} ${y2} Z`;
        }
      } else {
        const largeArc = sweep > Math.PI ? 1 : 0;
        const x1 = cx + Math.cos(startAngle) * outerR;
        const y1 = cy + Math.sin(startAngle) * outerR;
        const x2 = cx + Math.cos(endAngle) * outerR;
        const y2 = cy + Math.sin(endAngle) * outerR;
        if (innerR > 0) {
          const ix1 = cx + Math.cos(endAngle) * innerR;
          const iy1 = cy + Math.sin(endAngle) * innerR;
          const ix2 = cx + Math.cos(startAngle) * innerR;
          const iy2 = cy + Math.sin(startAngle) * innerR;
          path = `M ${x1} ${y1} A ${outerR} ${outerR} 0 ${largeArc} 1 ${x2} ${y2} L ${ix1} ${iy1} A ${innerR} ${innerR} 0 ${largeArc} 0 ${ix2} ${iy2} Z`;
        } else {
          path = `M ${cx} ${cy} L ${x1} ${y1} A ${outerR} ${outerR} 0 ${largeArc} 1 ${x2} ${y2} Z`;
        }
      }
      const share = (slice.value / total) * 100;
      return { ...slice, path, midAngle, share };
    });

    const listX = cx + outerR + 28;
    const maxListRows = Math.min(arcs.length, Math.max(4, Math.floor((svgHeight - 24) / 22)));
    const listTop = Math.max(16, (svgHeight - maxListRows * 22) / 2);

    return (
      <>
        {arcs.map((arc) => {
          const matched = isDatumMatched(activeFilter, primary.index, arc.index, arc.category);
          const isSelected = activeFilter !== null && matched;
          const offset = isSelected ? 5 : hoveredCatIndex === arc.index ? 3 : 0;
          const dx = Math.cos(arc.midAngle) * offset;
          const dy = Math.sin(arc.midAngle) * offset;
          return (
            <g key={`slice-${arc.index}`} transform={offset ? `translate(${dx.toFixed(1)} ${dy.toFixed(1)})` : undefined}>
              <path
                data-bi-datum={`${primary.index}:${arc.index}`}
                d={arc.path}
                fill={arc.color}
                stroke="hsl(var(--card))"
                strokeWidth={1.5}
                opacity={matched ? 0.92 : 0.28}
                className="cursor-pointer transition-opacity duration-100"
                onMouseEnter={() => {
                  setHoveredCatIndex(arc.index);
                  setTooltip({
                    x: Math.min(svgWidth - 175, Math.max(8, cx + Math.cos(arc.midAngle) * (outerR * 0.65))),
                    y: Math.max(8, cy + Math.sin(arc.midAngle) * (outerR * 0.65) - 24),
                    title: arc.category,
                    rows: [
                      {
                        color: arc.color,
                        name: primary.name,
                        value: formatBiValue(arc.value, primary.format, primary.currency),
                        share: `${arc.share.toFixed(1)}%`,
                      },
                    ],
                  });
                }}
                onMouseLeave={() => {
                  setHoveredCatIndex(null);
                  setTooltip(null);
                }}
                onClick={() =>
                  emitDatumClick({
                    seriesIndex: primary.index,
                    seriesName: primary.name,
                    datumIndex: arc.index,
                    category: arc.category,
                    value: arc.value,
                  })
                }
              />
              {showDataLabels && arc.share >= 6 && (
                <text
                  x={cx + Math.cos(arc.midAngle) * ((outerR + innerR) / 2)}
                  y={cy + Math.sin(arc.midAngle) * ((outerR + innerR) / 2) + 3.5}
                  textAnchor="middle"
                  fontSize={9.5}
                  fontWeight={600}
                  fill="#ffffff"
                  style={{ pointerEvents: 'none', fontVariantNumeric: 'tabular-nums' }}
                >
                  {`${Math.round(arc.share)}%`}
                </text>
              )}
            </g>
          );
        })}

        {chartType === 'donut' && (
          <g style={{ pointerEvents: 'none' }}>
            <text x={cx} y={cy - 4} textAnchor="middle" fontSize={15} fontWeight={600} fill="hsl(var(--foreground))" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {formatBiValue(total, primary.format, primary.currency)}
            </text>
            <text x={cx} y={cy + 13} textAnchor="middle" fontSize={10} fill="hsl(var(--muted-foreground))">
              {truncateLabel(primary.name, 16)}
            </text>
          </g>
        )}

        {showSideList && (
          <g>
            {arcs.slice(0, maxListRows).map((arc, rowIdx) => {
              const y = listTop + rowIdx * 22;
              const matched = isDatumMatched(activeFilter, primary.index, arc.index, arc.category);
              const availableW = Math.max(80, svgWidth - listX - 14);
              return (
                <g
                  key={`pie-leg-${arc.index}`}
                  opacity={matched ? 1 : 0.35}
                  className="cursor-pointer"
                  onClick={() =>
                    emitDatumClick({
                      seriesIndex: primary.index,
                      seriesName: primary.name,
                      datumIndex: arc.index,
                      category: arc.category,
                      value: arc.value,
                    })
                  }
                >
                  <rect x={listX} y={y + 2} width={8} height={8} rx={1.5} fill={arc.color} />
                  <text x={listX + 14} y={y + 9.5} fontSize={11} fill="hsl(var(--foreground))">
                    {truncateLabel(arc.category, Math.max(8, Math.floor((availableW - 80) / 6.5)))}
                  </text>
                  <text x={svgWidth - 12} y={y + 9.5} textAnchor="end" fontSize={10.5} fill="hsl(var(--muted-foreground))" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {`${formatBiValue(arc.value, primary.format, primary.currency)} (${arc.share.toFixed(1)}%)`}
                  </text>
                </g>
              );
            })}
          </g>
        )}
      </>
    );
  };

  const renderScatter = () => {
    const padLeft = yAxisLabel ? 64 : 52;
    const padRight = 18;
    const padTop = 14;
    const padBottom = xAxisLabel ? 44 : 30;
    const plotW = Math.max(80, svgWidth - padLeft - padRight);
    const plotH = Math.max(60, svgHeight - padTop - padBottom);

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const s of visibleSeries) {
      for (const pt of s.points) {
        if (pt.x < minX) minX = pt.x;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.y < minY) minY = pt.y;
        if (pt.y > maxY) maxY = pt.y;
      }
    }
    const xDomain = niceDomain(minX, maxX, false);
    const yDomain = niceDomain(minY, maxY, false);
    const sx = (v: number) => padLeft + ((v - xDomain.min) / Math.max(1e-9, xDomain.max - xDomain.min)) * plotW;
    const sy = (v: number) => padTop + plotH - ((v - yDomain.min) / Math.max(1e-9, yDomain.max - yDomain.min)) * plotH;

    return (
      <>
        {yDomain.ticks.map((tick) => {
          const y = sy(tick);
          return (
            <g key={`sy-${tick}`}>
              {showGrid && <line x1={padLeft} y1={y} x2={padLeft + plotW} y2={y} stroke="hsl(var(--border))" strokeDasharray="2 3" opacity={0.55} />}
              <text x={padLeft - 7} y={y + 3.5} textAnchor="end" fontSize={10} fill="hsl(var(--muted-foreground))" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {formatBiValue(tick, valueFormat, currency)}
              </text>
            </g>
          );
        })}
        {xDomain.ticks.map((tick) => {
          const x = sx(tick);
          return (
            <g key={`sx-${tick}`}>
              {showGrid && <line x1={x} y1={padTop} x2={x} y2={padTop + plotH} stroke="hsl(var(--border))" strokeDasharray="2 3" opacity={0.45} />}
              <text x={x} y={padTop + plotH + 14} textAnchor="middle" fontSize={10} fill="hsl(var(--muted-foreground))" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {formatBiValue(tick, 'compact', currency)}
              </text>
            </g>
          );
        })}

        {visibleSeries.map((s) =>
          s.points.map((pt, pi) => {
            const cx = sx(pt.x);
            const cy = sy(pt.y);
            const cat = pt.label || `${formatBiValue(pt.x, 'compact')}, ${formatBiValue(pt.y, s.format, s.currency)}`;
            const matched = isDatumMatched(activeFilter, s.index, pi, cat);
            return (
              <circle
                key={`sc-${s.id}-${pi}`}
                data-bi-datum={`${s.index}:${pi}`}
                cx={cx}
                cy={cy}
                r={pt.size}
                fill={s.color}
                fillOpacity={matched ? 0.78 : 0.2}
                stroke={s.color}
                strokeWidth={1.25}
                className="cursor-pointer"
                onMouseEnter={() => {
                  setTooltip({
                    x: cx > svgWidth * 0.62 ? Math.max(8, cx - 175) : Math.min(svgWidth - 175, cx + 12),
                    y: Math.max(8, cy - 28),
                    title: pt.label || s.name,
                    rows: [
                      {
                        color: s.color,
                        name: xAxisLabel || 'X',
                        value: formatBiValue(pt.x, 'compact', currency),
                      },
                      {
                        color: s.color,
                        name: yAxisLabel || s.name,
                        value: formatBiValue(pt.y, s.format, s.currency),
                      },
                    ],
                  });
                }}
                onMouseLeave={() => setTooltip(null)}
                onClick={() =>
                  emitDatumClick({
                    seriesIndex: s.index,
                    seriesName: s.name,
                    datumIndex: pi,
                    category: cat,
                    value: pt.y,
                    x: pt.x,
                    y: pt.y,
                  })
                }
              />
            );
          }),
        )}

        {xAxisLabel && (
          <text x={padLeft + plotW / 2} y={svgHeight - 4} textAnchor="middle" fontSize={10} fill="hsl(var(--muted-foreground))">
            {xAxisLabel}
          </text>
        )}
        {yAxisLabel && (
          <text x={14} y={padTop + plotH / 2} textAnchor="middle" fontSize={10} fill="hsl(var(--muted-foreground))" transform={`rotate(-90 14 ${padTop + plotH / 2})`}>
            {yAxisLabel}
          </text>
        )}
      </>
    );
  };

  const renderFunnel = () => {
    const primary = visibleSeries[0];
    if (!primary) return null;
    const stages = categories
      .map((cat, idx) => ({
        index: idx,
        category: cat,
        value: Math.max(0, primary.data[idx] ?? 0),
        color: resolveColor(undefined, palette, idx),
      }))
      .filter((s) => Number.isFinite(s.value));
    if (stages.length === 0) return null;

    const maxVal = Math.max(1e-9, ...stages.map((s) => s.value));
    const padX = 24;
    const padY = 14;
    const labelW = Math.min(140, Math.round(svgWidth * 0.26));
    const funnelLeft = padX + labelW;
    const funnelRight = svgWidth - padX - 82;
    const funnelW = Math.max(80, funnelRight - funnelLeft);
    const centerX = funnelLeft + funnelW / 2;
    const stageH = Math.max(20, (svgHeight - padY * 2) / stages.length);
    const gap = 3;

    return (
      <>
        {stages.map((stage, i) => {
          const topRatio = Math.max(0.14, stage.value / maxVal);
          const nextRatio = i < stages.length - 1 ? Math.max(0.12, stages[i + 1].value / maxVal) : Math.max(0.1, topRatio * 0.78);
          const topHalf = (funnelW * topRatio) / 2;
          const botHalf = (funnelW * nextRatio) / 2;
          const y1 = padY + i * stageH;
          const y2 = y1 + stageH - gap;
          const points = `${(centerX - topHalf).toFixed(1)},${y1.toFixed(1)} ${(centerX + topHalf).toFixed(1)},${y1.toFixed(1)} ${(centerX + botHalf).toFixed(1)},${y2.toFixed(1)} ${(centerX - botHalf).toFixed(1)},${y2.toFixed(1)}`;
          const shareOfTop = (stage.value / maxVal) * 100;
          const matched = isDatumMatched(activeFilter, primary.index, stage.index, stage.category);
          return (
            <g key={`funnel-${stage.index}`}>
              <text x={funnelLeft - 10} y={(y1 + y2) / 2 + 3.5} textAnchor="end" fontSize={11} fill="hsl(var(--foreground))">
                {truncateLabel(stage.category, 18)}
              </text>
              <polygon
                data-bi-datum={`${primary.index}:${stage.index}`}
                points={points}
                fill={stage.color}
                opacity={matched ? 0.88 : 0.28}
                className="cursor-pointer transition-opacity duration-100"
                onMouseEnter={() => {
                  setTooltip({
                    x: Math.min(svgWidth - 175, centerX + 12),
                    y: Math.max(8, y1),
                    title: stage.category,
                    rows: [
                      {
                        color: stage.color,
                        name: primary.name,
                        value: formatBiValue(stage.value, primary.format, primary.currency),
                        share: `${shareOfTop.toFixed(1)}%`,
                      },
                    ],
                  });
                }}
                onMouseLeave={() => setTooltip(null)}
                onClick={() =>
                  emitDatumClick({
                    seriesIndex: primary.index,
                    seriesName: primary.name,
                    datumIndex: stage.index,
                    category: stage.category,
                    value: stage.value,
                  })
                }
              />
              <text x={funnelRight + 10} y={(y1 + y2) / 2 + 3.5} textAnchor="start" fontSize={10.5} fill="hsl(var(--muted-foreground))" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {`${formatBiValue(stage.value, primary.format, primary.currency)} · ${Math.round(shareOfTop)}%`}
              </text>
            </g>
          );
        })}
      </>
    );
  };

  return (
    <div
      ref={containerRef}
      data-plugin-bi-chart={chartType}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      role="img"
      aria-label={ariaLabel || title || `BI ${chartType} chart`}
      className="relative flex w-full min-w-0 flex-col bg-card text-foreground select-none outline-none"
    >
      {/* Header + Export controls */}
      {(title || subtitle || exportable) && (
        <div className="flex items-start justify-between gap-2 px-3 pt-2.5 pb-1">
          <div className="min-w-0 flex-1">
            {title && <div className="truncate text-xs font-semibold text-foreground">{title}</div>}
            {subtitle && <div className="truncate text-[11px] text-muted-foreground">{subtitle}</div>}
          </div>
          {exportable && hasData && (
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                data-bi-export-svg=""
                onClick={handleExportSvg}
                title="Export SVG"
                aria-label="Export SVG"
                className="inline-flex h-6 items-center gap-1 px-1.5 text-[10.5px] font-medium text-muted-foreground hover:bg-muted/70 hover:text-foreground transition-colors"
              >
                <Download size={11} />
                SVG
              </button>
              <button
                type="button"
                data-bi-export-png=""
                onClick={handleExportPng}
                title="Export PNG"
                aria-label="Export PNG"
                className="inline-flex h-6 items-center gap-1 px-1.5 text-[10.5px] font-medium text-muted-foreground hover:bg-muted/70 hover:text-foreground transition-colors"
              >
                <Download size={11} />
                PNG
              </button>
            </div>
          )}
        </div>
      )}

      {/* Interactive Series Legend */}
      {showLegend && allSeries.length > 1 && chartType !== 'pie' && chartType !== 'donut' && chartType !== 'funnel' && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pb-1">
          {allSeries.map((s) => {
            const hidden = hiddenSeriesIds.has(s.id);
            return (
              <button
                key={s.id}
                type="button"
                data-bi-legend-series={s.id}
                aria-pressed={!hidden}
                onClick={() => toggleSeries(s.id)}
                className={`inline-flex items-center gap-1.5 text-[11px] transition-opacity ${
                  hidden ? 'opacity-40 line-through' : 'opacity-100 hover:opacity-80'
                }`}
              >
                <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
                <span className="text-muted-foreground">{s.name}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Chart SVG Surface */}
      <div className="relative w-full" style={{ height: `${svgHeight}px` }}>
        {!hasData ? (
          <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
            {emptyText}
          </div>
        ) : (
          <svg
            ref={svgRef}
            width={svgWidth}
            height={svgHeight}
            viewBox={`0 0 ${svgWidth} ${svgHeight}`}
            className="block h-full w-full overflow-visible"
          >
            {(chartType === 'pie' || chartType === 'donut') && renderPieOrDonut()}
            {chartType === 'scatter' && renderScatter()}
            {chartType === 'funnel' && renderFunnel()}
            {chartType !== 'pie' && chartType !== 'donut' && chartType !== 'scatter' && chartType !== 'funnel' && renderCartesianBody()}
          </svg>
        )}

        {/* 60fps Local Hover Tooltip */}
        {tooltip && (
          <div
            data-bi-tooltip=""
            className="pointer-events-none absolute z-20 min-w-[136px] max-w-[230px] border border-border bg-popover/95 px-2.5 py-1.5 text-[11px] text-popover-foreground shadow-md backdrop-blur-sm"
            style={{ left: `${Math.max(4, tooltip.x)}px`, top: `${Math.max(4, tooltip.y)}px` }}
          >
            <div className="mb-1 truncate font-medium text-foreground">{tooltip.title}</div>
            <div className="space-y-0.5">
              {tooltip.rows.map((row, idx) => (
                <div key={idx} className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: row.color }} />
                    <span className="truncate">{row.name}</span>
                  </span>
                  <span className="shrink-0 font-mono font-medium text-foreground tabular-nums">
                    {row.value}
                    {row.share ? <span className="ml-1 text-[10px] text-muted-foreground">({row.share})</span> : null}
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
