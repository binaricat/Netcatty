import React, { useEffect, useRef, useState } from "react";
import { RE2JS } from "re2js";
import type { Host, HostTotpConfig } from "../domain/models";
import { netcattyBridge } from "@/infrastructure/services/netcattyBridge.ts";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { HostDetailsSettingRow } from "./host-details";
import { SystemPanelConfirmDialog } from "./systemManager/SystemPanelConfirmDialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Switch } from "./ui/switch";

type Preview = {
  uri: string;
  code: string;
  secondsRemaining: number;
  issuer?: string;
  label?: string;
};

export type HostTotpFlushResult =
  | { ok: true; totp: HostTotpConfig | undefined }
  | { ok: false };

type HostTotpFieldsProps = {
  t: (key: string, params?: Record<string, string | number>) => string;
  form: Host;
  setForm: (updater: Host | ((host: Host) => Host)) => void;
  effectiveProtocol?: string;
  flushRef?: React.MutableRefObject<(() => Promise<HostTotpFlushResult>) | null>;
};

const HIDDEN_PROTOCOLS = new Set(["telnet", "serial"]);

function errorKey(error: string | undefined): string {
  switch (error) {
    case "hotp":
      return "hostDetails.totp.error.hotp";
    case "migration":
      return "hostDetails.totp.error.migration";
    case "not-found":
      return "hostDetails.totp.error.notFound";
    case "screen-permission-denied":
      return "hostDetails.totp.error.permission";
    case "unavailable":
      return "hostDetails.totp.error.unavailable";
    case "pattern":
      return "hostDetails.totp.error.pattern";
    default:
      return "hostDetails.totp.error.invalid";
  }
}

async function decodeQrFile(file: File): Promise<string> {
  // Loaded on demand: the decoder is only needed when importing a QR image,
  // but the host editor (and with it this module) is part of the startup bundle.
  const { default: jsQR } = await import("jsqr");
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("unavailable");
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(image.data, image.width, image.height)?.data || "";
  } finally {
    bitmap.close?.();
  }
}

function validPattern(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length > 200) return null;
  try {
    RE2JS.compile(trimmed);
    return trimmed;
  } catch {
    return null;
  }
}

function importedAccount(preview: Preview): string {
  const issuer = preview.issuer?.trim() || "";
  const label = preview.label?.trim() || "";
  if (issuer && label && !label.toLowerCase().startsWith(issuer.toLowerCase())) {
    return `${issuer} (${label})`;
  }
  return label || issuer;
}

function useLiveTotp(source: string | undefined, hostId: string): Preview | null {
  const [preview, setPreview] = useState<Preview | null>(null);
  const hostRef = useRef(hostId);
  hostRef.current = hostId;

  useEffect(() => {
    if (!source) {
      setPreview(null);
      return undefined;
    }
    const expectedHostId = hostId;
    let cancelled = false;
    const bridge = netcattyBridge.get();
    if (!bridge?.previewTotp) return undefined;
    const endsAtRef = { current: 0 };
    let refreshed = false;
    const apply = (next: Preview) => {
      if (cancelled || hostRef.current !== expectedHostId) return;
      endsAtRef.current = Date.now() + next.secondsRemaining * 1000;
      refreshed = false;
      setPreview(next);
    };
    void bridge.previewTotp({ text: source }).then((result) => {
      if (!result?.ok || !result.uri || !result.code) return;
      apply({
        uri: result.uri,
        code: result.code,
        secondsRemaining: result.secondsRemaining || result.period || 30,
        issuer: result.issuer,
        label: result.label,
      });
    }).catch(() => undefined);
    const timer = setInterval(() => {
      if (cancelled || !endsAtRef.current) return;
      const left = Math.max(0, Math.ceil((endsAtRef.current - Date.now()) / 1000));
      setPreview((current) => (
        current && current.secondsRemaining !== left
          ? { ...current, secondsRemaining: left }
          : current
      ));
      if (left !== 0 || refreshed) return;
      refreshed = true;
      void bridge.previewTotp({ text: source }).then((result) => {
        if (!result?.ok || !result.uri || !result.code) return;
        apply({
          uri: result.uri,
          code: result.code,
          secondsRemaining: result.secondsRemaining || result.period || 30,
          issuer: result.issuer,
          label: result.label,
        });
      }).catch(() => undefined);
    }, 250);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [hostId, source]);

  return source ? preview : null;
}

export const HostTotpFields: React.FC<HostTotpFieldsProps> = ({
  t,
  form,
  setForm,
  effectiveProtocol,
  flushRef,
}) => {
  const configured = Boolean(form.totp?.uri);
  const [setupOpen, setSetupOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [pattern, setPattern] = useState(form.totp?.promptPattern || "");
  const [autoSubmit, setAutoSubmit] = useState(form.totp?.autoSubmit !== false);
  const [modalUri, setModalUri] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const hostIdRef = useRef(form.id);
  const formRef = useRef(form);
  const setupOpenRef = useRef(setupOpen);
  const draftRef = useRef(draft);
  const patternRef = useRef(pattern);
  const autoSubmitRef = useRef(autoSubmit);
  const modalUriRef = useRef(modalUri);
  const requestRef = useRef(0);
  formRef.current = form;
  setupOpenRef.current = setupOpen;
  draftRef.current = draft;
  patternRef.current = pattern;
  autoSubmitRef.current = autoSubmit;
  modalUriRef.current = modalUri;

  const [trackedHostId, setTrackedHostId] = useState(form.id);
  if (form.id !== trackedHostId) {
    setTrackedHostId(form.id);
    setSetupOpen(false);
    setDraft("");
    setPattern(form.totp?.promptPattern || "");
    setAutoSubmit(form.totp?.autoSubmit !== false);
    setModalUri(undefined);
    setError(null);
    setBusy(false);
    setScanning(false);
    setConfirmClear(false);
    draftRef.current = "";
    patternRef.current = form.totp?.promptPattern || "";
    autoSubmitRef.current = form.totp?.autoSubmit !== false;
    modalUriRef.current = undefined;
    setupOpenRef.current = false;
  }
  hostIdRef.current = form.id;

  const rowPreview = useLiveTotp(form.totp?.uri, form.id);
  const modalPreview = useLiveTotp(setupOpen ? (modalUri || form.totp?.uri) : undefined, form.id);

  const writeTotp = (next: HostTotpConfig | undefined) => {
    const expectedHostId = hostIdRef.current;
    setForm((current) => {
      if (current.id !== expectedHostId) return current;
      const updated = { ...current };
      if (next?.uri) updated.totp = next;
      else delete updated.totp;
      return updated;
    });
  };

  const previewText = async (text: string): Promise<string | null> => {
    const expectedHostId = hostIdRef.current;
    const requestId = ++requestRef.current;
    const bridge = netcattyBridge.get();
    if (!bridge?.previewTotp) {
      setError("unavailable");
      return null;
    }
    setBusy(true);
    try {
      const result = await bridge.previewTotp({ text });
      if (hostIdRef.current !== expectedHostId || requestRef.current !== requestId) return null;
      if (!result?.ok || !result.uri || !result.code) {
        setError(result?.error || "invalid");
        return null;
      }
      setError(null);
      setModalUri(result.uri);
      modalUriRef.current = result.uri;
      setDraft("");
      draftRef.current = "";
      return result.uri;
    } catch {
      if (hostIdRef.current === expectedHostId && requestRef.current === requestId) setError("unavailable");
      return null;
    } finally {
      if (hostIdRef.current === expectedHostId && requestRef.current === requestId) setBusy(false);
    }
  };

  const commitSetup = async (options?: { requireSecret?: boolean }): Promise<HostTotpFlushResult> => {
    const expectedHostId = hostIdRef.current;
    const patternValue = validPattern(patternRef.current);
    if (patternValue == null) {
      setError("pattern");
      return { ok: false };
    }
    let uri = modalUriRef.current || formRef.current.totp?.uri;
    const text = draftRef.current.trim();
    if (text) {
      uri = await previewText(text) || undefined;
      if (hostIdRef.current !== expectedHostId) return { ok: false };
      if (!uri) return { ok: false };
    }
    if (!uri) {
      if (options?.requireSecret) {
        setError("invalid");
        return { ok: false };
      }
      return { ok: true, totp: formRef.current.totp };
    }
    const next: HostTotpConfig = {
      uri,
      autoSubmit: autoSubmitRef.current,
      ...(patternValue ? { promptPattern: patternValue } : {}),
    };
    writeTotp(next);
    setSetupOpen(false);
    setupOpenRef.current = false;
    setDraft("");
    draftRef.current = "";
    setModalUri(undefined);
    modalUriRef.current = undefined;
    setError(null);
    return { ok: true, totp: next };
  };
  const commitRef = useRef(commitSetup);
  commitRef.current = commitSetup;

  useEffect(() => {
    if (!flushRef) return undefined;
    const flush = async (): Promise<HostTotpFlushResult> => {
      const expectedHostId = hostIdRef.current;
      if (hostIdRef.current !== expectedHostId) return { ok: false };
      if (!setupOpenRef.current) return { ok: true, totp: formRef.current.totp };
      return commitRef.current();
    };
    flushRef.current = flush;
    return () => {
      if (flushRef.current === flush) flushRef.current = null;
    };
  }, [flushRef]);

  const openSetup = () => {
    setPattern(form.totp?.promptPattern || "");
    patternRef.current = form.totp?.promptPattern || "";
    setAutoSubmit(form.totp?.autoSubmit !== false);
    autoSubmitRef.current = form.totp?.autoSubmit !== false;
    setDraft("");
    draftRef.current = "";
    setModalUri(undefined);
    modalUriRef.current = undefined;
    setError(null);
    setSetupOpen(true);
    setupOpenRef.current = true;
  };

  const cancelSetup = () => {
    requestRef.current += 1;
    setSetupOpen(false);
    setupOpenRef.current = false;
    setDraft("");
    draftRef.current = "";
    setModalUri(undefined);
    modalUriRef.current = undefined;
    setError(null);
    setBusy(false);
    setScanning(false);
  };

  const clearTotp = () => {
    cancelSetup();
    writeTotp(undefined);
  };

  if (effectiveProtocol && HIDDEN_PROTOCOLS.has(effectiveProtocol)) return null;

  const scanScreen = async () => {
    const expectedHostId = form.id;
    const requestId = ++requestRef.current;
    const bridge = netcattyBridge.get();
    if (!bridge?.scanTotpQrFromScreen) {
      setError("unavailable");
      return;
    }
    setBusy(true);
    setScanning(true);
    try {
      const result = await bridge.scanTotpQrFromScreen();
      if (hostIdRef.current !== expectedHostId || requestRef.current !== requestId) return;
      if (!result?.ok || !result.uri || !result.code) {
        setError(result?.error || "not-found");
        return;
      }
      setError(null);
      setModalUri(result.uri);
      modalUriRef.current = result.uri;
      setDraft("");
      draftRef.current = "";
    } catch {
      if (hostIdRef.current === expectedHostId && requestRef.current === requestId) setError("unavailable");
    } finally {
      if (hostIdRef.current === expectedHostId && requestRef.current === requestId) {
        setBusy(false);
        setScanning(false);
      }
    }
  };

  return (
    <>
      <HostDetailsSettingRow
        label={t("hostDetails.totp.title")}
        hint={t("hostDetails.totp.warning")}
      >
        <div className="flex items-center gap-2">
          {rowPreview && (
            <span
              className="font-mono text-xs font-normal tabular-nums tracking-widest text-muted-foreground"
              title={t("hostDetails.totp.countdown", { seconds: rowPreview.secondsRemaining })}
            >
              {rowPreview.code}
            </span>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            onClick={openSetup}
          >
            {configured ? t("hostDetails.totp.edit") : t("hostDetails.totp.setup")}
          </Button>
        </div>
      </HostDetailsSettingRow>

      <Dialog open={setupOpen} onOpenChange={(open) => { if (!open) cancelSetup(); }}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>{t("hostDetails.totp.modalTitle")}</DialogTitle>
            <DialogDescription>{t("hostDetails.totp.warning")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="host-totp-secret">{t("hostDetails.totp.secret")}</Label>
              <Input
                id="host-totp-secret"
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  draftRef.current = event.target.value;
                }}
                onBlur={() => {
                  if (draftRef.current.trim()) void previewText(draftRef.current);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void commitSetup({ requireSecret: true });
                  }
                }}
                placeholder={configured ? t("hostDetails.totp.replacePlaceholder") : t("hostDetails.totp.secretPlaceholder")}
                aria-label={t("hostDetails.totp.secret")}
                className="h-8 font-mono text-xs"
                disabled={busy}
                spellCheck={false}
                autoFocus
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="h-8 focus:bg-secondary focus:text-secondary-foreground focus-visible:bg-secondary focus-visible:text-secondary-foreground"
                disabled={busy}
                onClick={() => fileRef.current?.click()}
              >
                {t("hostDetails.totp.importQr")}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="h-8 focus:bg-secondary focus:text-secondary-foreground focus-visible:bg-secondary focus-visible:text-secondary-foreground"
                disabled={busy}
                onClick={() => { void scanScreen(); }}
              >
                {scanning ? t("hostDetails.totp.scanning") : t("hostDetails.totp.scanScreen")}
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  const expectedHostId = form.id;
                  const requestId = ++requestRef.current;
                  setBusy(true);
                  void decodeQrFile(file)
                    .then((text) => {
                      if (hostIdRef.current !== expectedHostId || requestRef.current !== requestId) return;
                      if (!text) {
                        setError("not-found");
                        setBusy(false);
                        return;
                      }
                      return previewText(text);
                    })
                    .catch(() => {
                      if (hostIdRef.current !== expectedHostId || requestRef.current !== requestId) return;
                      setError("invalid");
                      setBusy(false);
                    });
                }}
              />
            </div>
            {modalPreview && (
              <div className="space-y-1">
                {importedAccount(modalPreview) ? (
                  <p className="text-sm text-foreground">
                    {t("hostDetails.totp.importedAccount", { account: importedAccount(modalPreview) })}
                  </p>
                ) : null}
                <p className="text-sm text-muted-foreground">
                  {t("hostDetails.totp.preview")}
                  {" "}
                  <span className="font-mono tracking-widest text-foreground">{modalPreview.code}</span>
                  <span className="ml-2">{t("hostDetails.totp.countdown", { seconds: modalPreview.secondsRemaining })}</span>
                </p>
              </div>
            )}
            {error && <p className="text-xs text-destructive">{t(errorKey(error))}</p>}
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{t("hostDetails.totp.autoSubmit")}</p>
                <p className="text-xs text-muted-foreground">{t("hostDetails.totp.autoSubmitDesc")}</p>
              </div>
              <Switch
                checked={autoSubmit}
                onCheckedChange={(checked) => {
                  setAutoSubmit(checked);
                  autoSubmitRef.current = checked;
                }}
                aria-label={t("hostDetails.totp.autoSubmit")}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="host-totp-pattern">{t("hostDetails.totp.promptPattern")}</Label>
              <Input
                id="host-totp-pattern"
                value={pattern}
                onChange={(event) => {
                  setPattern(event.target.value);
                  patternRef.current = event.target.value;
                  setError((current) => (current === "pattern" ? null : current));
                }}
                placeholder={t("hostDetails.totp.promptPatternPlaceholder")}
                aria-label={t("hostDetails.totp.promptPattern")}
                className="h-8 font-mono text-xs"
                spellCheck={false}
              />
            </div>
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            {configured ? (
              <Button type="button" variant="ghost" onClick={() => setConfirmClear(true)}>
                {t("hostDetails.totp.clear")}
              </Button>
            ) : <span />}
            <div className="flex gap-2">
              <Button type="button" variant="secondary" onClick={cancelSetup}>
                {t("common.cancel")}
              </Button>
              <Button type="button" onClick={() => { void commitSetup({ requireSecret: true }); }} disabled={busy}>
                {t("common.save")}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {confirmClear ? (
        <SystemPanelConfirmDialog
          open
          destructive
          title={t("hostDetails.totp.removeTitle")}
          message={t("hostDetails.totp.removeMessage")}
          confirmLabel={t("hostDetails.totp.clear")}
          onOpenChange={(open) => { if (!open) setConfirmClear(false); }}
          onConfirm={() => {
            setConfirmClear(false);
            clearTotp();
          }}
        />
      ) : null}
    </>
  );
};
