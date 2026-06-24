import { pinyin } from "pinyin-pro";

const SEARCH_SPLIT_REGEX = /[\s\p{Pd}_/\\|.,，。;；:：!！?？()（）[\]{}<>《》、"'`~·]+/u;
const SEARCH_REMOVE_REGEX = /[\s\p{Pd}_/\\|.,，。;；:：!！?？()（）[\]{}<>《》、"'`~·]+/gu;
const SEARCH_QUERY_SEGMENT_SPLIT_REGEX = /\s+/u;
const SEARCH_QUERY_PUNCT_REGEX = /[\p{Pd}_/\\|.,，。;；:：!！?？()（）[\]{}<>《》、"'`~·]/u;
const DASH_SEPARATOR_REGEX = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/gu;
const PINYIN_CACHE = new Map<string, { full: string; initials: string }>();
const IPV4_LIKE_REGEX = /^\d{1,3}(?:\.\d{1,3})+$/;
const HOST_PHASE_SCORE_BONUS = {
  strict: 1_000_000,
  loose: 100_000,
} as const;
const HOST_FIELD_SCORE = {
  label: 500,
  hostname: 380,
  group: 280,
  tag: 220,
} as const;
const HOST_METHOD_SCORE = {
  literal: 50,
  compact: 25,
  pinyinFull: 12,
  pinyinInitials: 8,
} as const;

function normalizeText(input: string): string {
  return input.normalize("NFKC").replace(DASH_SEPARATOR_REGEX, "-").toLowerCase().trim();
}

function compactText(input: string): string {
  return normalizeText(input).replace(SEARCH_REMOVE_REGEX, "");
}

function getPinyinVariants(sourceText: string): { full: string; initials: string } {
  const cacheKey = normalizeText(sourceText);
  const cached = PINYIN_CACHE.get(cacheKey);
  if (cached) return cached;

  let full = "";
  let initials = "";

  try {
    full = compactText(
      pinyin(sourceText, {
        toneType: "none",
      }),
    );
    initials = compactText(
      pinyin(sourceText, {
        pattern: "first",
        toneType: "none",
      }),
    );
  } catch {
    // ignore conversion failures
  }

  const next = { full, initials };
  PINYIN_CACHE.set(cacheKey, next);
  return next;
}

export function tokenizeSearchQuery(query: string): string[] {
  const normalized = normalizeText(query);
  if (!normalized) return [];
  return normalized.split(SEARCH_SPLIT_REGEX).filter(Boolean);
}

export function matchesSearchQuery(
  query: string,
  ...fields: Array<string | null | undefined>
): boolean {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return true;

  const normalizedFields = fields
    .filter((field): field is string => typeof field === "string" && field.trim().length > 0)
    .map((field) => normalizeText(field));
  if (normalizedFields.length === 0) return false;

  // For dotted numeric input (IPv4-like), require contiguous literal match.
  if (IPV4_LIKE_REGEX.test(normalizedQuery)) {
    return normalizedFields.some((field) => field.includes(normalizedQuery));
  }

  const tokens = tokenizeSearchQuery(normalizedQuery);
  if (tokens.length === 0) return false;

  const sourceText = normalizedFields.join(" ");
  const haystack = sourceText;
  if (haystack.includes(normalizedQuery)) {
    return true;
  }

  const haystackCompact = compactText(sourceText);
  const compactQuery = compactText(normalizedQuery);
  if (compactQuery && haystackCompact.includes(compactQuery)) {
    return true;
  }

  if (tokens.every((token) => haystack.includes(token))) {
    return true;
  }

  const hasLatinToken = tokens.some((token) => /[a-z]/i.test(token));
  if (!hasLatinToken) return false;

  const { full, initials } = getPinyinVariants(sourceText);
  if (!full && !initials) return false;

  return tokens.every((token) => {
    if (haystack.includes(token)) return true;
    const compactToken = compactText(token);
    return (
      (full && full.includes(compactToken)) ||
      (initials && initials.includes(compactToken))
    );
  });
}

/**
 * Host search should avoid mixing label/group tokens with hostname/IP tokens.
 * Otherwise queries like "山东 6-1" can accidentally match:
 * - "山东" from group/label
 * - "6" / "1" from hostname IP
 * across different fields.
 */
export function matchesHostSearchQuery(
  query: string,
  hostLike: {
    label?: string | null;
    hostname?: string | null;
    group?: string | null;
    tags?: Array<string | null | undefined> | null;
  },
): boolean {
  return getHostSearchMatch(query, hostLike).matched;
}

type HostMatchField = "label" | "hostname" | "group" | "tag";
type HostMatchMethod = "literal" | "compact" | "pinyinFull" | "pinyinInitials";
type HostMatchPhase = "strict" | "loose";

export type HostSearchMatchDetail = {
  segment: string;
  field: HostMatchField;
  method: HostMatchMethod;
  phase: HostMatchPhase;
};

export type HostSearchMatchResult = {
  matched: boolean;
  phase: HostMatchPhase | "none";
  score: number;
  details: HostSearchMatchDetail[];
};

type HostSearchFieldSource = {
  field: HostMatchField;
  allowPinyin: boolean;
  text: string;
  compact: string;
};

function scoreHostMatch(detail: HostSearchMatchDetail): number {
  return HOST_FIELD_SCORE[detail.field] + HOST_METHOD_SCORE[detail.method];
}

function selectBetterHostMatch(
  left: HostSearchMatchResult,
  right: HostSearchMatchResult,
): HostSearchMatchResult {
  if (!left.matched) return right;
  if (!right.matched) return left;
  if (left.score !== right.score) {
    return left.score > right.score ? left : right;
  }
  if (left.details.length !== right.details.length) {
    return left.details.length < right.details.length ? left : right;
  }
  return left;
}

function matchSegmentAgainstSource(
  segment: string,
  source: HostSearchFieldSource,
): HostSearchMatchDetail | null {
  if (source.text.includes(segment)) {
    return {
      segment,
      field: source.field,
      method: "literal",
      phase: "strict",
    };
  }

  // Keep punctuation semantic (e.g. 6-, 6-1, 10.6.1.8): no compact fallback.
  if (SEARCH_QUERY_PUNCT_REGEX.test(segment)) return null;

  const compactSegment = compactText(segment);
  if (
    compactSegment
    && source.field !== "hostname"
    && source.compact.includes(compactSegment)
  ) {
    return {
      segment,
      field: source.field,
      method: "compact",
      phase: "loose",
    };
  }

  if (!source.allowPinyin || !/[a-z]/i.test(segment)) return null;

  const { full, initials } = getPinyinVariants(source.text);
  if (full && full.includes(compactSegment)) {
    return {
      segment,
      field: source.field,
      method: "pinyinFull",
      phase: "loose",
    };
  }
  if (initials && initials.includes(compactSegment)) {
    return {
      segment,
      field: source.field,
      method: "pinyinInitials",
      phase: "loose",
    };
  }

  return null;
}

function evaluateHostFieldGroup(
  segments: string[],
  sources: HostSearchFieldSource[],
): HostSearchMatchResult {
  if (sources.length === 0) {
    return { matched: false, phase: "none", score: 0, details: [] };
  }

  const details: HostSearchMatchDetail[] = [];
  let isStrict = true;

  for (const segment of segments) {
    let best: HostSearchMatchDetail | null = null;
    let bestScore = -1;

    for (const source of sources) {
      const detail = matchSegmentAgainstSource(segment, source);
      if (!detail) continue;

      const score = scoreHostMatch(detail);
      if (score > bestScore) {
        best = detail;
        bestScore = score;
      }
    }

    if (!best) {
      return { matched: false, phase: "none", score: 0, details: [] };
    }
    if (best.phase !== "strict") {
      isStrict = false;
    }
    details.push(best);
  }

  const phase: HostMatchPhase = isStrict ? "strict" : "loose";
  const baseScore = details.reduce((sum, detail) => sum + scoreHostMatch(detail), 0);
  return {
    matched: true,
    phase,
    score: baseScore + HOST_PHASE_SCORE_BONUS[phase],
    details,
  };
}

export function getHostSearchMatch(
  query: string,
  hostLike: {
    label?: string | null;
    hostname?: string | null;
    group?: string | null;
    tags?: Array<string | null | undefined> | null;
  },
): HostSearchMatchResult {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) {
    return { matched: true, phase: "strict", score: HOST_PHASE_SCORE_BONUS.strict, details: [] };
  }

  const querySegments = normalizedQuery
    .split(SEARCH_QUERY_SEGMENT_SPLIT_REGEX)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (querySegments.length === 0) {
    return { matched: true, phase: "strict", score: HOST_PHASE_SCORE_BONUS.strict, details: [] };
  }

  const label = normalizeText(hostLike.label ?? "");
  const group = normalizeText(hostLike.group ?? "");
  const hostname = normalizeText(hostLike.hostname ?? "");
  const tags = (hostLike.tags ?? [])
    .filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0)
    .map((tag) => normalizeText(tag));

  const humanSources: HostSearchFieldSource[] = [];
  if (label) {
    humanSources.push({
      field: "label",
      allowPinyin: true,
      text: label,
      compact: compactText(label),
    });
  }
  if (group) {
    humanSources.push({
      field: "group",
      allowPinyin: true,
      text: group,
      compact: compactText(group),
    });
  }
  for (const tag of tags) {
    humanSources.push({
      field: "tag",
      allowPinyin: true,
      text: tag,
      compact: compactText(tag),
    });
  }

  const networkSources: HostSearchFieldSource[] = hostname
    ? [{
      field: "hostname",
      allowPinyin: false,
      text: hostname,
      compact: compactText(hostname),
    }]
    : [];

  const humanResult = evaluateHostFieldGroup(querySegments, humanSources);
  const networkResult = evaluateHostFieldGroup(querySegments, networkSources);
  return selectBetterHostMatch(humanResult, networkResult);
}

export function getHostSearchReason(match: HostSearchMatchResult): string {
  if (!match.matched || match.details.length === 0) return "";
  const uniqueFields = Array.from(new Set(match.details.map((detail) => detail.field)));
  const phaseLabel = match.phase === "strict" ? "strict" : "loose";
  return `${phaseLabel}:${uniqueFields.join("/")}`;
}
