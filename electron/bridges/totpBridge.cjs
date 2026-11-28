"use strict";

const {
  previewTotpText,
  selectTotpFromQrPayloads,
  bgraToRgba,
  currentTotp,
} = require("../../domain/totp.shared.cjs");

const MAX_INPUT_LENGTH = 4096;

function screenCaptureStatus(electron) {
  try {
    return electron?.systemPreferences?.getMediaAccessStatus?.("screen") || "unknown";
  } catch {
    return "unknown";
  }
}

function isScreenPermissionError(error) {
  const message = String(error?.message || error || "");
  return /denied|permission|not authorized|not permitted/i.test(message);
}

function thumbnailSizeForDisplay(display) {
  const scale = Number(display?.scaleFactor) || 1;
  const width = Math.max(1, Math.round((display?.size?.width || display?.bounds?.width || 1920) * scale));
  const height = Math.max(1, Math.round((display?.size?.height || display?.bounds?.height || 1080) * scale));
  return { width, height };
}

function largestThumbnailSize(displays) {
  if (!displays.length) return { width: 1920, height: 1080 };
  let width = 1;
  let height = 1;
  for (const display of displays) {
    const size = thumbnailSizeForDisplay(display);
    width = Math.max(width, size.width);
    height = Math.max(height, size.height);
  }
  return { width, height };
}

function pushThumbnail(images, image) {
  if (!image?.getSize || typeof image.toBitmap !== "function") return;
  const size = image.getSize();
  if (!size?.width || !size?.height) return;
  images.push({ width: size.width, height: size.height, bitmap: image.toBitmap() });
}

function sourceDisplayId(source) {
  if (source?.display_id == null) return "";
  return String(source.display_id);
}

async function captureScreenBitmaps(electron) {
  const desktopCapturer = electron?.desktopCapturer;
  const screen = electron?.screen;
  if (!desktopCapturer?.getSources || !screen?.getAllDisplays) {
    throw new Error("unavailable");
  }
  const displays = screen.getAllDisplays() || [];
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: largestThumbnailSize(displays),
    fetchWindowIcons: false,
  });
  const images = [];
  const used = new Set();
  const take = (source) => {
    if (!source || used.has(source)) return;
    used.add(source);
    pushThumbnail(images, source.thumbnail);
  };
  const matchedDisplayIds = new Set();
  for (const display of displays) {
    const displayId = String(display?.id);
    const match = sources.find((source) => sourceDisplayId(source) !== "" && sourceDisplayId(source) === displayId);
    if (!match) continue;
    matchedDisplayIds.add(displayId);
    take(match);
  }
  for (const source of sources) {
    const displayId = sourceDisplayId(source);
    if (displayId && matchedDisplayIds.has(displayId)) continue;
    take(source);
  }
  return images;
}

function decodeBitmaps(images, decode) {
  const payloads = [];
  for (const image of images) {
    const rgba = bgraToRgba(image.bitmap, image.width, image.height);
    const result = decode(rgba, image.width, image.height);
    if (result?.data) payloads.push(result.data);
  }
  return payloads;
}

function publicPreviewFromParsed(parsed, timestamp) {
  const current = currentTotp(parsed, timestamp);
  return {
    ok: true,
    uri: parsed.uri,
    code: current.code,
    secondsRemaining: current.secondsRemaining,
    period: parsed.period,
    algorithm: parsed.algorithm,
    digits: parsed.digits,
    issuer: parsed.issuer,
    label: parsed.label,
  };
}

function previewTotpInput(payload, now = Date.now()) {
  const text = typeof payload?.text === "string" ? payload.text : payload?.uri;
  if (typeof text !== "string" || text.length > MAX_INPUT_LENGTH) {
    return { ok: false, error: "invalid" };
  }
  return previewTotpText(text, now);
}

async function scanScreensForTotp(deps = {}) {
  const electron = deps.electron;
  const status = screenCaptureStatus(electron);
  if (status === "denied" || status === "restricted") {
    return { ok: false, error: "screen-permission-denied" };
  }
  let images;
  try {
    images = await (deps.capture || captureScreenBitmaps)(electron);
  } catch (error) {
    if (isScreenPermissionError(error)) return { ok: false, error: "screen-permission-denied" };
    return { ok: false, error: "unavailable" };
  }
  if (!images?.length) {
    const platform = deps.platform || process.platform;
    if (platform === "darwin" && status !== "granted") {
      return { ok: false, error: "screen-permission-denied" };
    }
    return { ok: false, error: "not-found" };
  }
  const decode = deps.decode || ((data, width, height) => {
    const jsQR = require("jsqr");
    return jsQR(data, width, height);
  });
  let payloads;
  try {
    payloads = decodeBitmaps(images, decode);
  } catch {
    return { ok: false, error: "not-found" };
  }
  const selected = selectTotpFromQrPayloads(payloads);
  if (!selected.ok) return { ok: false, error: selected.error };
  return publicPreviewFromParsed(selected.parsed, deps.now?.() ?? Date.now());
}

function registerTotpHandlers(ipcMain, electronModule) {
  ipcMain.handle("netcatty:totp:preview", (_event, payload) => previewTotpInput(payload));
  ipcMain.handle("netcatty:totp:scan-screen", () => scanScreensForTotp({ electron: electronModule }));
}

module.exports = {
  registerTotpHandlers,
  scanScreensForTotp,
  previewTotpInput,
  captureScreenBitmaps,
};
