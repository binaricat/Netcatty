export type TerminalCjkFontOptionKind =
  | 'auto'
  | 'recommended'
  | 'installed'
  | 'unverified'
  | 'unavailable';

export interface TerminalCjkFontOption {
  value: string;
  kind: TerminalCjkFontOptionKind;
}

export const RECOMMENDED_CJK_FONT_FAMILIES = [
  'Sarasa Mono SC',
  'Sarasa Mono TC',
  'Maple Mono CN',
  'Source Han Mono SC',
  'Noto Sans Mono CJK SC',
  'LXGW WenKai Mono',
  'SimSun',
] as const;

const recommendedByLower = new Map(
  RECOMMENDED_CJK_FONT_FAMILIES.map((family) => [family.toLowerCase(), family]),
);

const normalize = (value: string): string => value.trim().toLowerCase();

interface BuildOptionsArgs {
  installedFamilies: readonly string[] | null | undefined;
  selectedValue: string;
  availableRecommendedFamilies?: readonly string[];
}

export function buildTerminalCjkFontOptions({
  installedFamilies,
  selectedValue,
  availableRecommendedFamilies = [],
}: BuildOptionsArgs): TerminalCjkFontOption[] {
  const trimmedSelected = selectedValue.trim();
  const selectedKey = normalize(trimmedSelected);
  const preserveSelectedValue = (family: string): string =>
    normalize(family) === selectedKey && trimmedSelected ? selectedValue : family;
  const installedByLower = new Map<string, string>();
  for (const rawFamily of installedFamilies ?? []) {
    const family = rawFamily.trim();
    if (!family) continue;
    const key = normalize(family);
    if (!installedByLower.has(key)) installedByLower.set(key, family);
  }

  const availableRecommended = new Set(
    availableRecommendedFamilies.map(normalize),
  );
  const options: TerminalCjkFontOption[] = [{ value: '', kind: 'auto' }];

  for (const family of RECOMMENDED_CJK_FONT_FAMILIES) {
    const key = normalize(family);
    if (!installedByLower.has(key) && !availableRecommended.has(key)) continue;
    options.push({ value: preserveSelectedValue(family), kind: 'recommended' });
    installedByLower.delete(key);
  }

  const remainingInstalled = [...installedByLower.values()].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' }),
  );
  options.push(
    ...remainingInstalled.map((value) => ({
      value: preserveSelectedValue(value),
      kind: 'installed' as const,
    })),
  );

  const alreadyVisible = options.some((option) => normalize(option.value) === selectedKey);
  if (trimmedSelected && !alreadyVisible) {
    options.push({
      value: selectedValue,
      kind: installedFamilies == null ? 'unverified' : 'unavailable',
    });
  }

  return options;
}

export type TerminalCjkFontSelectionStatus =
  | 'auto'
  | 'recommended'
  | 'alignment-risk'
  | 'unavailable';

export function getTerminalCjkFontSelectionStatus(
  value: string,
  installedFamilies: readonly string[] | null | undefined,
  availableRecommendedFamilies: readonly string[] = [],
  selectedFontAvailable = false,
): TerminalCjkFontSelectionStatus {
  const normalizedValue = normalize(value);
  if (!normalizedValue) return 'auto';

  const isInstalled = (installedFamilies ?? []).some(
    (family) => normalize(family) === normalizedValue,
  );
  const isAvailableRecommended = availableRecommendedFamilies.some(
    (family) => normalize(family) === normalizedValue,
  );
  const isAvailable = isInstalled || isAvailableRecommended || selectedFontAvailable;
  if (recommendedByLower.has(normalizedValue) && isAvailable) {
    return 'recommended';
  }
  if (installedFamilies == null) return 'alignment-risk';
  return isAvailable ? 'alignment-risk' : 'unavailable';
}
