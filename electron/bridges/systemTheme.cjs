"use strict";

// Keep system-theme delivery independent of optional plugin menu contributions.
function registerSystemThemeListener({ nativeTheme, getWindows }) {
  const onUpdated = () => {
    const payload = { isDark: nativeTheme.shouldUseDarkColors === true };
    for (const win of getWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      win.webContents.send("netcatty:system-theme-changed", payload);
    }
  };
  nativeTheme.on("updated", onUpdated);
  return () => nativeTheme.removeListener("updated", onUpdated);
}

module.exports = { registerSystemThemeListener };
