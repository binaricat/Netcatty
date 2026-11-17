/**
 * zh-CN / zh-TW overlays for bundled Fig autocomplete descriptions.
 * Each dictionary is keyed by the exact English description string.
 * Spec objects stay in English; only suggestion copies shown in the popup change.
 *
 * The two dictionaries are separate dynamic imports so the renderer fetches
 * only the chunk for the active UI locale. zh-TW is generated from zh-CN with
 * OpenCC s2twp via scripts/generate-autocomplete-descriptions-zh-TW.mjs.
 */

import { COMMAND_DESCRIPTIONS } from "./commandDescriptions";

type DescriptionDictionary = Record<string, string>;

let zhCnDictionaryPromise: Promise<DescriptionDictionary> | undefined;
let zhTwDictionaryPromise: Promise<DescriptionDictionary> | undefined;

function dictionaryFromModule(
  mod: { default?: DescriptionDictionary } | DescriptionDictionary,
): DescriptionDictionary {
  const loaded = mod as { default?: DescriptionDictionary };
  return loaded.default ?? (mod as DescriptionDictionary);
}

function loadZhCnDescriptions(): Promise<DescriptionDictionary> {
  zhCnDictionaryPromise ??= import("./descriptions.zh-CN.json").then(dictionaryFromModule);
  return zhCnDictionaryPromise;
}

function loadZhTwDescriptions(): Promise<DescriptionDictionary> {
  zhTwDictionaryPromise ??= import("./descriptions.zh-TW.json").then(dictionaryFromModule);
  return zhTwDictionaryPromise;
}

function loadDescriptionsForLocale(locale: string): Promise<DescriptionDictionary> | undefined {
  if (locale === "zh-CN") return loadZhCnDescriptions();
  if (locale === "zh-TW") return loadZhTwDescriptions();
  return undefined;
}

/**
 * Copy spec-backed suggestions so a locale overlay cannot leak into the
 * cached spec or into a later query in another locale.
 */
export async function localizeSpecSuggestionDescriptions<T extends { description?: string }>(
  suggestions: readonly T[],
  locale: string | undefined,
): Promise<readonly T[]> {
  if (!locale || suggestions.length === 0) return suggestions;
  const pending = loadDescriptionsForLocale(locale);
  if (!pending) return suggestions;

  let dictionary: DescriptionDictionary;
  try {
    dictionary = await pending;
  } catch {
    return suggestions;
  }
  let changed = false;
  const localized = suggestions.map((suggestion) => {
    const description = suggestion.description;
    if (!description) return suggestion;
    const translated = dictionary[description];
    if (!translated) return suggestion;
    changed = true;
    return { ...suggestion, description: translated };
  });
  return changed ? localized : suggestions;
}

/**
 * Command-name suggestions have no description until the command's spec is
 * loaded. Fill them from the generated command description map so the popup
 * can show a short Chinese hint (e.g. "cp  复制文件或目录") without loading
 * every spec. Non-Chinese locales keep their existing behaviour.
 */
export function localizeCommandSuggestionDescriptions<
  T extends { source?: string; displayText?: string; description?: string },
>(suggestions: readonly T[], locale: string | undefined): readonly T[] {
  if (locale !== "zh-CN" && locale !== "zh-TW") return suggestions;
  let changed = false;
  const localized = suggestions.map((suggestion) => {
    if (suggestion.source !== "command" || suggestion.description) return suggestion;
    const entry = COMMAND_DESCRIPTIONS[suggestion.displayText ?? ""];
    if (!entry) return suggestion;
    const description =
      locale === "zh-CN"
        ? entry.zhCN ?? entry.en
        : entry.zhTW ?? entry.zhCN ?? entry.en;
    if (!description) return suggestion;
    changed = true;
    return { ...suggestion, description };
  });
  return changed ? localized : suggestions;
}
