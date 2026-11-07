import { useEffect, useId, useState } from "react";
import { useI18n } from "../../../application/i18n/I18nProvider";
import {
  applyPluginThemeSelection,
  usePluginThemeRevision,
} from "../../../application/state/usePluginThemeRuntime";
import { pluginThemeRegistry } from "../../../infrastructure/config/pluginThemeRegistry";
import { Button } from "../../ui/button";

export function PluginThemePicker({
  mode,
  onRestore,
}: {
  mode: "light" | "dark";
  onRestore: () => void;
}) {
  const { t } = useI18n();
  usePluginThemeRevision();
  const owner = useId();
  const [selected, setSelected] = useState(""),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const catalog = pluginThemeRegistry.getCatalog();
  const entries = catalog.entries.filter((e) => e.palette.base === mode);
  const applied = catalog.selection[mode];
  const appliedAvailable =
    applied &&
    entries.some(
      (e) =>
        e.ref.pluginId === applied.ref.pluginId &&
        e.ref.themeId === applied.ref.themeId &&
        e.ref.version === applied.ref.version &&
        e.ref.digest === applied.ref.digest,
    );
  const entry = entries.find(
    (e) => `${e.ref.pluginId}/${e.ref.themeId}` === selected,
  );
  useEffect(
    () => () => pluginThemeRegistry.cancelPreview(owner),
    [owner, mode],
  );
  async function apply(restore = false) {
    if (pending || (!restore && !entry)) return;
    setPending(true);
    setError("");
    try {
      await applyPluginThemeSelection(
        mode,
        restore ? null : { ref: entry!.ref },
      );
      pluginThemeRegistry.cancelPreview(owner);
      if (restore) {
        setSelected("");
        onRestore();
      }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : t("settings.plugins.themes.failed"),
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <section
      className="space-y-3 py-3"
      aria-label={t("settings.plugins.themes.title")}
    >
      <div>
        <h4 className="text-sm font-medium">
          {t("settings.plugins.themes.title")}
        </h4>
        <p className="text-xs text-muted-foreground">
          {t("settings.plugins.themes.description")}
        </p>
      </div>
      {entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("settings.plugins.themes.empty")}
        </p>
      ) : (
        <select
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          aria-label={t("settings.plugins.themes.choose")}
          value={entry ? selected : ""}
          disabled={pending}
          onChange={(e) => {
            pluginThemeRegistry.cancelPreview(owner);
            setSelected(e.target.value);
            setError("");
          }}
        >
          <option value="">{t("settings.plugins.themes.choose")}</option>
          {entries.map((e) => (
            <option
              key={`${e.ref.pluginId}/${e.ref.themeId}`}
              value={`${e.ref.pluginId}/${e.ref.themeId}`}
            >
              {e.label} — {e.pluginName} {e.ref.version}
            </option>
          ))}
        </select>
      )}
      {catalog.selection[mode] && (
        <p className="text-xs text-muted-foreground">
          {t(
            appliedAvailable
              ? "settings.plugins.themes.applied"
              : "settings.plugins.themes.unavailable",
          )}
          : {catalog.selection[mode]!.ref.themeId} ·{" "}
          {catalog.selection[mode]!.ref.version}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!entry || pending}
          onClick={() => {
            if (entry) pluginThemeRegistry.startPreview(owner, entry);
          }}
        >
          {t("settings.plugins.themes.preview")}
        </Button>
        <Button
          size="sm"
          disabled={!entry || pending}
          onClick={() => {
            void apply();
          }}
        >
          {t("settings.plugins.themes.apply")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => pluginThemeRegistry.cancelPreview(owner)}
        >
          {t("settings.plugins.themes.cancel")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => {
            void apply(true);
          }}
        >
          {t("settings.plugins.themes.restore")}
        </Button>
      </div>
      {catalog.diagnostics.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {t("settings.plugins.themes.invalid")}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
