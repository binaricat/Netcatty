import React, { useCallback, useEffect, useState } from "react";
import { useI18n } from "../../../../application/i18n/I18nProvider";
import { netcattyBridge } from "../../../../infrastructure/services/netcattyBridge";
import { SettingRow, SettingsSection } from "../../settings-ui";

/**
 * Login state for the vendor AI assistants.
 *
 * The assistants live behind the vendors' own web chat, so there is nothing to
 * configure here beyond signing in once: the browser profile is reused for
 * every later question.
 */
export const VendorAssistantSettings: React.FC<{ anchorId?: string }> = ({ anchorId }) => {
  const { t } = useI18n();
  const [status, setStatus] = useState<VendorAssistantStatusResult | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const readStatus = useCallback(async () => {
    const bridge = netcattyBridge.get();
    if (!bridge?.aiVendorAssistantStatus) return null;
    try {
      const next = await bridge.aiVendorAssistantStatus();
      return next?.ok ? next : null;
    } catch {
      return null;
    }
  }, []);

  const refresh = useCallback(async () => {
    setStatus(await readStatus());
  }, [readStatus]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The sign-in call only settles once the vendor page shows its composer, and
  // some vendors keep that window open for minutes. Polling the status keeps
  // the row from sitting on "Signing in…" after the profile is already usable.
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => {
      void refresh();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [pending, refresh]);

  useEffect(() => {
    if (!pending) return;
    const vendor = status?.vendors?.find((entry) => entry.key === pending);
    if (vendor?.login !== "logged") return;
    setPending(null);
    setNotice(t("ai.vendor.loginDone"));
  }, [pending, status, t]);

  const handleLogin = useCallback(
    async (vendor: string) => {
      const bridge = netcattyBridge.get();
      if (!bridge?.aiVendorAssistantLogin) return;
      setPending(vendor);
      setNotice(t("ai.vendor.loginStarted"));
      try {
        const result = await bridge.aiVendorAssistantLogin(vendor, 300000);
        const fresh = await readStatus();
        setStatus(fresh);
        const login = fresh?.vendors?.find((entry) => entry.key === vendor)?.login;
        const signedIn = login ? login === "logged" : result?.logged === true;
        if (!result?.ok) setNotice(t("ai.vendor.loginFailed"));
        else if (signedIn) setNotice(t("ai.vendor.loginDone"));
        // A vendor that lets guests chat opens its composer without a sign-in,
        // so "the window is ready" must not be reported as "signed in".
        else setNotice(t("ai.vendor.loginStarted"));
      } catch {
        setNotice(t("ai.vendor.loginFailed"));
      } finally {
        setPending(null);
      }
    },
    [readStatus, t],
  );

  const vendors = status?.vendors ?? [];
  const stateLabel = (login: string) => {
    if (login === "logged") return t("ai.vendor.state.logged");
    if (login === "unknown") return t("ai.vendor.state.unknown");
    return t("ai.vendor.state.missing");
  };

  return (
    <SettingsSection anchorId={anchorId ?? "ai-vendor-assistant"} title={t("ai.vendor.title")}>
      <p className="text-xs text-muted-foreground">{t("ai.vendor.description")}</p>
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">
          {status?.profileRoot ? `${t("ai.vendor.profile")}: ${status.profileRoot}` : t("ai.vendor.unavailable")}
        </span>
        <button
          type="button"
          className="text-xs underline underline-offset-2 disabled:opacity-50"
          disabled={pending !== null}
          onClick={() => void refresh()}
        >
          {t("ai.vendor.refresh")}
        </button>
      </div>
      {vendors.map((vendor) => (
        <SettingRow
          key={vendor.key}
          label={vendor.name}
          description={stateLabel(vendor.login)}
        >
          <button
            type="button"
            className="rounded border px-2 py-1 text-xs disabled:opacity-50"
            disabled={pending !== null}
            onClick={() => void handleLogin(vendor.key)}
          >
            {pending === vendor.key ? t("ai.vendor.loggingIn") : t("ai.vendor.login")}
          </button>
        </SettingRow>
      ))}
      {notice ? <p className="text-xs text-muted-foreground">{notice}</p> : null}
    </SettingsSection>
  );
};
