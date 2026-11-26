import type { PluginErRelation, PluginErTable } from './types';

export const ER_CARD_WIDTH = 252;
export const ER_CARD_HEADER_HEIGHT = 34;
export const ER_CARD_ROW_HEIGHT = 24;
export const ER_CARD_FOOTER_PADDING = 8;

/** Abbreviate verbose SQL types (especially PostgreSQL catalog names) so ER cards never clip mid-word. */
export function abbreviateSqlType(rawType: string): string {
  const trimmed = rawType.trim();
  if (!trimmed) return '';
  let out = trimmed
    .replace(/\bcharacter\s+varying\b/gi, 'varchar')
    .replace(/\bcharacter\b(?=\s*\()/gi, 'char')
    .replace(/\btimestamp\s*(?:\(\d+\)\s*)?with\s+time\s+zone\b/gi, 'timestamptz')
    .replace(/\btimestamp\s*(?:\(\d+\)\s*)?without\s+time\s+zone\b/gi, 'timestamp')
    .replace(/\btime\s*(?:\(\d+\)\s*)?with\s+time\s+zone\b/gi, 'timetz')
    .replace(/\btime\s*(?:\(\d+\)\s*)?without\s+time\s+zone\b/gi, 'time')
    .replace(/\bdouble\s+precision\b/gi, 'float8')
    .replace(/\bboolean\b/gi, 'bool')
    .replace(/\binteger\b/gi, 'int4')
    .replace(/\bsmallint\b/gi, 'int2')
    .replace(/\bbigint\b/gi, 'int8')
    .replace(/\s+/g, ' ');
  if (out.length > 18) {
    out = `${out.slice(0, 17)}…`;
  }
  return out;
}

export function erTableKey(table: Pick<PluginErTable, 'name' | 'schema'>): string {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}

export function erCardHeight(table: PluginErTable): number {
  return ER_CARD_HEADER_HEIGHT + Math.max(1, table.columns.length) * ER_CARD_ROW_HEIGHT + ER_CARD_FOOTER_PADDING;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface ErSvgPalette {
  background: string;
  card: string;
  cardForeground: string;
  muted: string;
  mutedForeground: string;
  border: string;
  primary: string;
}

export function buildStandaloneErSvg(
  tables: PluginErTable[],
  relations: PluginErRelation[],
  positions: Record<string, { x: number; y: number }>,
  palette: ErSvgPalette,
): string {
  const byKey = new Map<string, PluginErTable>();
  const byName = new Map<string, PluginErTable>();
  for (const tbl of tables) {
    byKey.set(erTableKey(tbl), tbl);
    if (!byName.has(tbl.name)) byName.set(tbl.name, tbl);
  }
  const resolveTable = (ref: string) => byKey.get(ref) ?? byName.get(ref);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const tbl of tables) {
    const pos = positions[erTableKey(tbl)] ?? { x: 40, y: 40 };
    minX = Math.min(minX, pos.x);
    minY = Math.min(minY, pos.y);
    maxX = Math.max(maxX, pos.x + ER_CARD_WIDTH);
    maxY = Math.max(maxY, pos.y + erCardHeight(tbl));
  }
  if (!Number.isFinite(minX)) {
    minX = 0; minY = 0; maxX = 400; maxY = 240;
  }
  const pad = 40;
  const vbX = Math.floor(minX - pad);
  const vbY = Math.floor(minY - pad);
  const vbW = Math.max(200, Math.ceil(maxX - minX + pad * 2));
  const vbH = Math.max(160, Math.ceil(maxY - minY + pad * 2));

  const lines: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${vbW}" height="${vbH}" viewBox="${vbX} ${vbY} ${vbW} ${vbH}">`,
    `<rect x="${vbX}" y="${vbY}" width="${vbW}" height="${vbH}" fill="${escapeXml(palette.background)}" />`,
  ];

  for (const rel of relations) {
    const fromTable = resolveTable(rel.fromTable);
    const toTable = resolveTable(rel.toTable);
    if (!fromTable || !toTable) continue;
    const fromPos = positions[erTableKey(fromTable)] ?? { x: 0, y: 0 };
    const toPos = positions[erTableKey(toTable)] ?? { x: 0, y: 0 };
    const fromColIdx = Math.max(0, fromTable.columns.findIndex((c) => c.name === rel.fromColumn));
    const toColIdx = Math.max(0, toTable.columns.findIndex((c) => c.name === rel.toColumn));
    const y1 = fromPos.y + ER_CARD_HEADER_HEIGHT + fromColIdx * ER_CARD_ROW_HEIGHT + ER_CARD_ROW_HEIGHT / 2;
    const y2 = toPos.y + ER_CARD_HEADER_HEIGHT + toColIdx * ER_CARD_ROW_HEIGHT + ER_CARD_ROW_HEIGHT / 2;
    const goRight = (toPos.x + ER_CARD_WIDTH / 2) >= (fromPos.x + ER_CARD_WIDTH / 2);
    const x1 = goRight ? fromPos.x + ER_CARD_WIDTH : fromPos.x;
    const x2 = goRight ? toPos.x : toPos.x + ER_CARD_WIDTH;
    const dx = Math.max(48, Math.abs(x2 - x1) * 0.45);
    const c1x = goRight ? x1 + dx : x1 - dx;
    const c2x = goRight ? x2 - dx : x2 + dx;
    lines.push(
      `<path d="M ${x1} ${y1} C ${c1x} ${y1}, ${c2x} ${y2}, ${x2} ${y2}" fill="none" stroke="${escapeXml(palette.mutedForeground)}" stroke-width="1.5" stroke-opacity="0.75" />`,
      `<circle cx="${x1}" cy="${y1}" r="3.5" fill="${escapeXml(palette.mutedForeground)}" />`,
      `<circle cx="${x2}" cy="${y2}" r="3.5" fill="${escapeXml(palette.background)}" stroke="${escapeXml(palette.mutedForeground)}" stroke-width="1.8" />`,
    );
  }

  for (const tbl of tables) {
    const pos = positions[erTableKey(tbl)] ?? { x: 0, y: 0 };
    const h = erCardHeight(tbl);
    const title = tbl.schema ? `${tbl.schema}.${tbl.name}` : tbl.name;
    lines.push(`<g transform="translate(${pos.x}, ${pos.y})">`);
    lines.push(`<rect width="${ER_CARD_WIDTH}" height="${h}" rx="8" fill="${escapeXml(palette.card)}" stroke="${escapeXml(palette.border)}" stroke-width="1" />`);
    lines.push(`<path d="M 0 8 Q 0 0 8 0 L ${ER_CARD_WIDTH - 8} 0 Q ${ER_CARD_WIDTH} 0 ${ER_CARD_WIDTH} 8 L ${ER_CARD_WIDTH} ${ER_CARD_HEADER_HEIGHT} L 0 ${ER_CARD_HEADER_HEIGHT} Z" fill="${escapeXml(palette.muted)}" />`);
    lines.push(`<line x1="0" y1="${ER_CARD_HEADER_HEIGHT}" x2="${ER_CARD_WIDTH}" y2="${ER_CARD_HEADER_HEIGHT}" stroke="${escapeXml(palette.border)}" stroke-width="1" />`);
    lines.push(`<text x="12" y="21" font-size="12" font-weight="600" font-family="system-ui, -apple-system, sans-serif" fill="${escapeXml(palette.cardForeground)}">${escapeXml(title)}</text>`);

    tbl.columns.forEach((col, colIdx) => {
      const rowY = ER_CARD_HEADER_HEIGHT + colIdx * ER_CARD_ROW_HEIGHT;
      const badgeOffset = (col.isPk ? 26 : 0) + (col.isFk ? 26 : 0);
      const shortType = `${abbreviateSqlType(col.type)}${col.nullable ? '?' : ''}`;
      const colLabel = col.name.length > 18 ? `${col.name.slice(0, 17)}…` : col.name;
      lines.push(`<g transform="translate(0, ${rowY})">`);
      if (colIdx > 0) {
        lines.push(`<line x1="8" y1="0" x2="${ER_CARD_WIDTH - 8}" y2="0" stroke="${escapeXml(palette.border)}" stroke-opacity="0.45" stroke-width="0.75" />`);
      }
      if (col.isPk) {
        lines.push(`<rect x="8" y="5" width="22" height="14" rx="3" fill="#f59e0b" fill-opacity="0.2" /><text x="19" y="15.5" text-anchor="middle" font-size="9" font-weight="700" font-family="system-ui, sans-serif" fill="#d97706">PK</text>`);
      }
      if (col.isFk) {
        const fkX = col.isPk ? 34 : 8;
        lines.push(`<rect x="${fkX}" y="5" width="22" height="14" rx="3" fill="#3b82f6" fill-opacity="0.2" /><text x="${fkX + 11}" y="15.5" text-anchor="middle" font-size="9" font-weight="700" font-family="system-ui, sans-serif" fill="#2563eb">FK</text>`);
      }
      lines.push(`<text x="${10 + badgeOffset}" y="16" font-size="11" font-family="ui-monospace, monospace" fill="${escapeXml(palette.cardForeground)}">${escapeXml(colLabel)}</text>`);
      lines.push(`<text x="${ER_CARD_WIDTH - 10}" y="16" text-anchor="end" font-size="10" font-family="ui-monospace, monospace" fill="${escapeXml(palette.mutedForeground)}">${escapeXml(shortType)}</text>`);
      lines.push('</g>');
    });
    lines.push('</g>');
  }

  lines.push('</svg>');
  return lines.join('\n');
}
