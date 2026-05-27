import React, { useCallback, useMemo } from "react";
import { useI18n } from "../../application/i18n/I18nProvider";
import {
  effectiveDefaultAlgorithms,
  SSH_ALGORITHM_CATEGORIES,
  SSHAlgorithmCategory,
  SUPPORTED_ALGORITHMS_BY_CATEGORY,
} from "../../domain/sshAlgorithmList";
import type { HostAlgorithmOverrides } from "../../domain/models";
import { Button } from "../ui/button";
import { Card } from "../ui/card";

interface Props {
  value: HostAlgorithmOverrides | undefined;
  onChange: (next: HostAlgorithmOverrides | undefined) => void;
  /**
   * The host's current `legacyAlgorithms` value, used to seed the very
   * first customization in each category with the *effective* default
   * list (modern-only vs modern+legacy) rather than the full SUPPORTED
   * set. Without this, unchecking a single algorithm in modern mode
   * would silently start advertising CBC / arcfour / MD5 algorithms.
   */
  legacyEnabled: boolean;
  /**
   * Algorithm overrides this host would inherit from its group when its
   * own field is unset. Used purely for display: an `undefined` value
   * here means the host can freely use NetCatty defaults by resetting
   * a category; a populated value means the host would inherit those
   * lists, and resetting locally falls back to them — the panel
   * surfaces that so the user knows the local Reset button doesn't
   * jump them to NetCatty's defaults in that case.
   */
  inheritedFromGroup?: HostAlgorithmOverrides;
}

const CATEGORY_LABEL_KEY: Record<SSHAlgorithmCategory, string> = {
  kex: "hostDetails.algorithms.category.kex",
  cipher: "hostDetails.algorithms.category.cipher",
  hmac: "hostDetails.algorithms.category.hmac",
  serverHostKey: "hostDetails.algorithms.category.serverHostKey",
  compress: "hostDetails.algorithms.category.compress",
};

/**
 * Per-category SSH algorithm override editor.
 *
 * When a category's array is `undefined`, that category uses NetCatty's
 * negotiated default list. When it's a non-empty array, that array fully
 * replaces the offered list for the category.
 *
 * Picking zero algorithms in a category is equivalent to "use default" —
 * an empty array would make ssh2 fail negotiation, so we normalize it
 * back to `undefined` on save.
 */
export const AlgorithmOverridesPanel: React.FC<Props> = ({
  value,
  onChange,
  legacyEnabled,
  inheritedFromGroup,
}) => {
  const { t } = useI18n();
  const effectiveDefault = useMemo(
    () => effectiveDefaultAlgorithms(legacyEnabled),
    [legacyEnabled],
  );
  const inheritedCategories = useMemo(() => {
    if (!inheritedFromGroup) return [] as SSHAlgorithmCategory[];
    return SSH_ALGORITHM_CATEGORIES.filter((category) => {
      const list = inheritedFromGroup[category];
      return Array.isArray(list) && list.length > 0;
    });
  }, [inheritedFromGroup]);

  const updateCategory = useCallback(
    (category: SSHAlgorithmCategory, selected: string[]) => {
      // Start from the inherited group overrides so that touching one
      // category doesn't silently drop inheritance for the others.
      // `applyGroupDefaults` treats `host.algorithms` as an
      // all-or-nothing inherit boundary: once the host carries any
      // explicit object, the host's `algorithms` shadows the group's
      // `algorithms` entirely. If the user customized cipher locally
      // and the group restricted serverHostKey, simply storing
      // `{ cipher: [...] }` on the host would lose the group's
      // serverHostKey restriction. Persisting the inherited categories
      // alongside keeps the effective offer intact.
      const base: HostAlgorithmOverrides = inheritedFromGroup
        ? { ...inheritedFromGroup }
        : {};
      const next: HostAlgorithmOverrides = { ...base, ...(value ?? {}) };
      if (selected.length === 0) {
        delete next[category];
      } else {
        next[category] = selected;
      }
      const hasAny = Object.values(next).some((arr) => Array.isArray(arr) && arr.length > 0);
      onChange(hasAny ? next : undefined);
    },
    [value, onChange, inheritedFromGroup],
  );

  const toggleAlgorithm = useCallback(
    (category: SSHAlgorithmCategory, algo: string) => {
      const current = value?.[category];
      if (!current) {
        // First click in this category — seed with the *effective* offer
        // for this category. If the group has set a list for this
        // category, use that (so customizing one entry doesn't lose the
        // group's narrowing). Otherwise seed from NetCatty's effective
        // default, which already accounts for legacy mode. Seeding from
        // SUPPORTED_ALGORITHMS_BY_CATEGORY would silently introduce
        // legacy algorithms (CBC, arcfour, MD5) into the offered list.
        const baseline = inheritedFromGroup?.[category] ?? effectiveDefault[category];
        if (baseline.includes(algo)) {
          updateCategory(category, baseline.filter((a) => a !== algo));
        } else {
          // The user clicked an algorithm not in the baseline — they
          // want to opt INTO it. Start the override with the baseline
          // plus this extra entry.
          updateCategory(category, [...baseline, algo]);
        }
        return;
      }
      if (current.includes(algo)) {
        updateCategory(category, current.filter((a) => a !== algo));
      } else {
        updateCategory(category, [...current, algo]);
      }
    },
    [value, updateCategory, effectiveDefault, inheritedFromGroup],
  );

  const resetCategory = useCallback(
    (category: SSHAlgorithmCategory) => {
      const next: HostAlgorithmOverrides = { ...(value ?? {}) };
      delete next[category];
      const hasAny = Object.values(next).some((arr) => Array.isArray(arr) && arr.length > 0);
      onChange(hasAny ? next : undefined);
    },
    [value, onChange],
  );

  const isCustomized = useCallback(
    (category: SSHAlgorithmCategory) => Array.isArray(value?.[category]),
    [value],
  );

  const isChecked = useCallback(
    (category: SSHAlgorithmCategory, algo: string) => {
      const current = value?.[category];
      if (current) return current.includes(algo);
      // No host-local override: reflect what the host would actually
      // advertise — the group's inherited list when present, else
      // NetCatty's effective default. Algorithms outside both
      // (e.g. arcfour in modern mode) appear unchecked, hinting that
      // ticking them implies opting into something normally not offered.
      const baseline = inheritedFromGroup?.[category] ?? effectiveDefault[category];
      return baseline.includes(algo);
    },
    [value, effectiveDefault, inheritedFromGroup],
  );

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground break-words">
        {t("hostDetails.algorithms.advanced.desc")}
      </p>
      {inheritedCategories.length > 0 && (
        <div className="flex items-start gap-2 p-2 rounded-md bg-blue-500/10 border border-blue-500/20">
          <p className="text-xs text-blue-700 dark:text-blue-300 break-words">
            {t("hostDetails.algorithms.inheritedNotice")
              .replace(
                "{categories}",
                inheritedCategories.map((c) => t(CATEGORY_LABEL_KEY[c])).join(", "),
              )}
          </p>
        </div>
      )}
      {SSH_ALGORITHM_CATEGORIES.map((category) => {
        const supported = SUPPORTED_ALGORITHMS_BY_CATEGORY[category];
        const customized = isCustomized(category);
        return (
          <Card key={category} className="p-2 space-y-1.5 bg-background border-border/60">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium">
                {t(CATEGORY_LABEL_KEY[category])}
                {customized && (
                  <span className="ml-1.5 text-[10px] text-yellow-600 dark:text-yellow-400">
                    {t("hostDetails.algorithms.customized")}
                  </span>
                )}
              </p>
              {customized && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => resetCategory(category)}
                >
                  {t("hostDetails.algorithms.reset")}
                </Button>
              )}
            </div>
            <div className="grid grid-cols-1 gap-1">
              {supported.map((algo) => (
                <label
                  key={algo}
                  className="flex items-center gap-2 text-[11px] cursor-pointer select-none hover:bg-accent/40 rounded px-1 py-0.5"
                >
                  <input
                    type="checkbox"
                    className="h-3 w-3"
                    checked={isChecked(category, algo)}
                    onChange={() => toggleAlgorithm(category, algo)}
                  />
                  <span className="font-mono truncate" title={algo}>{algo}</span>
                </label>
              ))}
            </div>
          </Card>
        );
      })}
    </div>
  );
};
