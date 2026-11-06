import React, { useEffect, useRef, useState } from "react";
import { useI18n } from "../../../../application/i18n/I18nProvider";
import { useAIPrivacyState } from "../../../../application/state/useExternalMcpToggleState";
import { Button } from "../../../ui/button";
import { ToolSettingsDialog } from "./ToolSettingsDialog";
import { SettingCard, SettingRow, SettingsSection, Toggle } from "../../settings-ui";

export const AIPrivacySection: React.FC = () => {
  const { t } = useI18n();
  const { settings, error, applying, apply } = useAIPrivacyState();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [privateIps, setPrivateIps] = useState(settings.redactPrivateIps);
  const [cidrs, setCidrs] = useState(settings.cidrs.join("\n"));
  const [patterns, setPatterns] = useState(settings.patterns.join("\n"));
  const [applied, setApplied] = useState(false);
  const [open, setOpen] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (open && error) errorRef.current?.focus(); }, [open, error]);
  const [draftBase, setDraftBase] = useState(settings);
  const [conflict, setConflict] = useState(false);
  const dirty = enabled !== draftBase.enabled || privateIps !== draftBase.redactPrivateIps
    || cidrs !== draftBase.cidrs.join("\n") || patterns !== draftBase.patterns.join("\n");
  const changeOpen = (next: boolean) => {
    if (applying) return;
    setDraftBase(settings);
    setEnabled(settings.enabled);
    setPrivateIps(settings.redactPrivateIps);
    setCidrs(settings.cidrs.join("\n"));
    setPatterns(settings.patterns.join("\n"));
    setConflict(false);
    setOpen(next);
  };

  const draftState = useRef({ open, dirty, applying });
  draftState.current = { open, dirty, applying };
  useEffect(() => {
    if (draftState.current.open && draftState.current.dirty && !draftState.current.applying) {
      setConflict(true);
      return;
    }
    setDraftBase(settings);
    setEnabled(settings.enabled);
    setPrivateIps(settings.redactPrivateIps);
    setCidrs(settings.cidrs.join("\n"));
    setPatterns(settings.patterns.join("\n"));
  }, [settings]);

  const onApply = async () => {
    if (applying || conflict) return;
    setApplied(false);
    const saved = await apply({
      enabled,
      redactPrivateIps: privateIps,
      cidrs: cidrs.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      patterns: patterns.split(/\r?\n/).filter((line) => line.trim().length > 0),
    });
    setApplied(saved);
    if (saved) setOpen(false);
  };

  return (
    <SettingsSection anchorId="ai-privacy" title={t("ai.privacy.title")}>
      <p className="text-xs text-muted-foreground leading-5">{t("ai.privacy.description")}</p>
      <p className="text-xs text-muted-foreground leading-5">{t("ai.privacy.boundary")}</p>
      <SettingCard>
        <SettingRow
          className="flex-col items-start md:flex-row md:items-center"
          label={t(settings.enabled ? "ai.toolSettings.privacyOn" : "ai.toolSettings.privacyOff")}
          description={`${t("ai.privacy.privateIps")}: ${t(settings.redactPrivateIps ? "common.enabled" : "common.disabled")} · ${t("ai.toolSettings.ruleSummary", { cidrs: String(settings.cidrs.length), patterns: String(settings.patterns.length) })}`}
        >
          <ToolSettingsDialog
            title={t("ai.privacy.title")}
            triggerLabel={t("ai.toolSettings.configurePrivacy")}
            open={open}
            onOpenChange={changeOpen}
            busy={applying}
            footer={<>
              {dirty ? <span role="status" className="mr-auto self-center text-xs text-muted-foreground">{t("ai.toolSettings.unsaved")}</span> : null}
              <Button type="button" variant="outline" onClick={() => changeOpen(false)} disabled={applying}>{t("common.cancel")}</Button>
              <Button type="button" onClick={() => { void onApply(); }} disabled={applying || conflict || (!dirty && !error)}>
                {t(applying ? "ai.privacy.applying" : "ai.privacy.apply")}
              </Button>
            </>}
          >
            <p className="text-xs text-muted-foreground leading-5">{t("ai.privacy.description")}</p>
            <p className="text-xs text-muted-foreground leading-5">{t("ai.privacy.boundary")}</p>
      <SettingCard divided className="border-0 rounded-none bg-transparent p-0">
        <SettingRow label={t("ai.privacy.enable")}>
          <Toggle
            checked={enabled}
            onChange={(next) => { setEnabled(next); setApplied(false); }}
            ariaLabel={t("ai.privacy.enable")}
            disabled={applying}
          />
        </SettingRow>
        <SettingRow
          label={t("ai.privacy.privateIps")}
          description={t("ai.privacy.privateIps.description")}
        >
          <Toggle
            checked={privateIps}
            onChange={(next) => { setPrivateIps(next); setApplied(false); }}
            ariaLabel={t("ai.privacy.privateIps")}
            disabled={applying}
          />
        </SettingRow>
      </SettingCard>
      <div className="space-y-4">
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">{t("ai.privacy.cidrs")}</span>
          <span className="block text-xs text-muted-foreground">{t("ai.privacy.cidrs.description")}</span>
          <textarea
            value={cidrs}
            onChange={(event) => { setCidrs(event.currentTarget.value); setApplied(false); }}
            aria-label={t("ai.privacy.cidrs")}
            placeholder={"192.0.2.0/24\n2001:db8::/32"}
            rows={3}
            spellCheck={false}
            disabled={applying}
            className="w-full resize-y rounded-md border border-border/60 bg-background px-2 py-1.5 font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">{t("ai.privacy.patterns")}</span>
          <span className="block text-xs text-muted-foreground">{t("ai.privacy.patterns.description")}</span>
          <textarea
            value={patterns}
            onChange={(event) => { setPatterns(event.currentTarget.value); setApplied(false); }}
            aria-label={t("ai.privacy.patterns")}
            placeholder="INTERNAL_[A-Z0-9]+"
            rows={3}
            spellCheck={false}
            disabled={applying}
            className="w-full resize-y rounded-md border border-border/60 bg-background px-2 py-1.5 font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </label>
        <p className="text-xs text-muted-foreground leading-5">{t("ai.privacy.connectionScope")}</p>
        <p className="text-xs text-amber-500">{t("ai.privacy.reconnect")}</p>
      </div>
            {conflict ? <p role="alert" className="text-xs text-destructive">{t("ai.toolSettings.conflict")}</p> : null}
            {error ? <p ref={errorRef} tabIndex={-1} role="alert" className="text-xs text-destructive">{t("ai.privacy.failed")} {error}</p> : null}
          </ToolSettingsDialog>
        </SettingRow>
      </SettingCard>
      {error && !open ? <p role="alert" className="text-xs text-destructive">{t("ai.privacy.failed")} {error}</p>
        : applied ? <p role="status" className="text-xs text-emerald-500">{t("ai.privacy.applied")}</p> : null}
    </SettingsSection>
  );
};
