export const parseCsv = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        const next = text[i + 1];
        if (next === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }

    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      continue;
    }

    field += ch;
  }

  row.push(field);
  rows.push(row);
  return rows;
};

const normalizeHeaderKey = (raw: string): string => {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
};

export const findHeaderIndex = (headers: string[], candidates: string[]): number => {
  const normalized = headers.map((h) => normalizeHeaderKey(h));
  for (const cand of candidates) {
    const c = cand.toLowerCase();
    for (let i = 0; i < normalized.length; i++) {
      const h = normalized[i];
      if (h === c || h.startsWith(c)) return i;
    }
  }
  return -1;
};

export const findExactHeaderIndex = (headers: string[], candidates: string[]): number => {
  const normalized = headers.map((header) => normalizeHeaderKey(header));
  const candidateKeys = new Set(candidates.map((candidate) => normalizeHeaderKey(candidate)));
  return normalized.findIndex((header) => candidateKeys.has(header));
};
