"use strict";

const path = require("node:path");
const fs = require("node:fs");

const VALID_VARIANTS = new Set([
  "original",
  "bright",
  "dark",
  "colorful",
  "high-contrast",
  "white-navy",
  "white-sky",
  "white-rose",
  "white-emerald",
  "white-amber",
  "white-violet",
  "rainbow",
]);

const DEFAULT_VARIANT = "original";

let currentVariant = DEFAULT_VARIANT;
let currentIconPath = null;
let preferPublicSources = false;
let useMacIconSources = false;

function isValidAppIconVariant(variant) {
  return typeof variant === "string" && VALID_VARIANTS.has(variant);
}

function normalizeAppIconVariant(variant) {
  return isValidAppIconVariant(variant) ? variant : DEFAULT_VARIANT;
}

function isPackagedApp(app) {
  try {
    return app?.isPackaged === true;
  } catch {
    return false;
  }
}

function pickExistingPath(candidates) {
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function buildSourceCandidates(appPath, relativeParts) {
  const publicCandidate = path.join(appPath, "public", ...relativeParts);
  const distCandidate = path.join(appPath, "dist", ...relativeParts);
  return preferPublicSources
    ? [publicCandidate, distCandidate]
    : [distCandidate, publicCandidate];
}

function resolveOriginalIconPath(appPath) {
  const primaryParts = useMacIconSources
    ? ["icons", "variants", "macos", "original.png"]
    : ["icons", "variants", "original.png"];
  const candidates = useMacIconSources
    ? buildSourceCandidates(appPath, primaryParts)
    : [
        ...buildSourceCandidates(appPath, primaryParts),
        ...buildSourceCandidates(appPath, ["icon-win.png"]),
        ...buildSourceCandidates(appPath, ["icon.png"]),
      ];
  return pickExistingPath(candidates) || candidates[0];
}

function buildVariantSourceCandidates(appPath, fileName) {
  const relativeParts = useMacIconSources
    ? ["icons", "variants", "macos", fileName]
    : ["icons", "variants", fileName];
  return buildSourceCandidates(appPath, relativeParts);
}

function resolveVariantIconPath(variant, appPath) {
  const normalized = normalizeAppIconVariant(variant);
  if (normalized === "original") {
    return resolveOriginalIconPath(appPath);
  }

  const fileName = `${normalized}.png`;
  const candidates = buildVariantSourceCandidates(appPath, fileName);
  const resolved = pickExistingPath(candidates);
  if (resolved) return resolved;
  return resolveOriginalIconPath(appPath);
}

function resolveStrictVariantIconPath(variant, appPath) {
  const normalized = normalizeAppIconVariant(variant);
  if (normalized === "original") {
    return resolveOriginalIconPath(appPath);
  }

  const fileName = `${normalized}.png`;
  const candidates = buildVariantSourceCandidates(appPath, fileName);
  return pickExistingPath(candidates) || null;
}

function initializeAppIconManager(appPath, options = {}) {
  preferPublicSources = options.preferPublic === true;
  useMacIconSources = options.isMac === true;
  currentVariant = DEFAULT_VARIANT;
  currentIconPath = resolveVariantIconPath(currentVariant, appPath);
  return currentIconPath;
}

function getAppIconPath(appPath) {
  if (!currentIconPath) {
    return initializeAppIconManager(appPath);
  }
  return currentIconPath;
}

function getAppIconVariant() {
  return currentVariant;
}

function createNativeImage(nativeImage, iconPath) {
  if (!nativeImage || !iconPath || !fs.existsSync(iconPath)) return null;
  try {
    // Read from disk so regenerated assets at the same path refresh immediately.
    return nativeImage.createFromBuffer(fs.readFileSync(iconPath));
  } catch {
    try {
      return nativeImage.createFromPath(iconPath);
    } catch {
      return null;
    }
  }
}

function applyIconToWindow(win, iconPath, nativeImage) {
  if (!win || win.isDestroyed?.() || !iconPath || !win.setIcon) return;
  try {
    const image = createNativeImage(nativeImage, iconPath);
    if (image) {
      win.setIcon(image);
      return;
    }
    win.setIcon(iconPath);
  } catch {
    // ignore
  }
}

function applyAppIconVariant(variant, context) {
  const { app, BrowserWindow, nativeImage, appPath, isMac } = context;
  preferPublicSources = !isPackagedApp(app);
  useMacIconSources = isMac === true;
  const normalized = normalizeAppIconVariant(variant);
  const iconPath = resolveStrictVariantIconPath(normalized, appPath);
  if (!iconPath || !fs.existsSync(iconPath)) {
    return false;
  }

  currentVariant = normalized;
  currentIconPath = iconPath;

  const windows = BrowserWindow?.getAllWindows?.() || [];
  for (const win of windows) {
    applyIconToWindow(win, iconPath, nativeImage);
  }

  if (isMac && app?.dock?.setIcon && nativeImage) {
    try {
      const dockImage = createNativeImage(nativeImage, iconPath);
      if (dockImage) {
        app.dock.setIcon(dockImage);
      }
    } catch {
      // ignore
    }
  }

  return true;
}

module.exports = {
  DEFAULT_VARIANT,
  VALID_VARIANTS,
  isValidAppIconVariant,
  normalizeAppIconVariant,
  initializeAppIconManager,
  getAppIconPath,
  getAppIconVariant,
  resolveVariantIconPath,
  resolveStrictVariantIconPath,
  applyAppIconVariant,
  applyIconToWindow,
};
