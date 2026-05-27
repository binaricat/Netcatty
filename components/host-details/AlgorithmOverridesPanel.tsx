import React, { useCallback } from "react";
import { useI18n } from "../../application/i18n/I18nProvider";
import {
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
export const AlgorithmOverridesPanel: React.FC<Props> = ({ value, onChange }) => {
  const { t } = useI18n();

  const updateCategory = useCallback(
    (category: SSHAlgorithmCategory, selected: string[]) => {
      const next: HostAlgorithmOverrides = { ...(value ?? {}) };
      if (selected.length === 0) {
        delete next[category];
      } else {
        next[category] = selected;
      }
      const hasAny = Object.values(next).some((arr) => Array.isArray(arr) && arr.length > 0);
      onChange(hasAny ? next : undefined);
    },
    [value, onChange],
  );

  const toggleAlgorithm = useCallback(
    (category: SSHAlgorithmCategory, algo: string) => {
      const current = value?.[category];
      if (!current) {
        // First click in this category — seed with every default-on algorithm
        // EXCEPT the one being toggled off.
        const all = SUPPORTED_ALGORITHMS_BY_CATEGORY[category];
        updateCategory(category, all.filter((a) => a !== algo));
        return;
      }
      if (current.includes(algo)) {
        updateCategory(category, current.filter((a) => a !== algo));
      } else {
        updateCategory(category, [...current, algo]);
      }
    },
    [value, updateCategory],
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
      // Uncustomized → treat every supported algorithm as on (the default).
      if (!current) return true;
      return current.includes(algo);
    },
    [value],
  );

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground break-words">
        {t("hostDetails.algorithms.advanced.desc")}
      </p>
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
