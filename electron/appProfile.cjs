const fs = require("node:fs");
const path = require("node:path");

function configureAppProfile(app, devServerUrl) {
  const unpackaged = !app.isPackaged;
  const isDev = unpackaged && Boolean(devServerUrl);
  if (unpackaged) {
    // Keep the existing development profile path for both Vite and dist.
    app.setName("Netcatty Dev");
    const devProfile = path.join(app.getPath("userData"), "dev");
    fs.mkdirSync(devProfile, { recursive: true });
    app.setPath("userData", devProfile);
    // Chromium's Local Storage, IndexedDB and other session state must
    // follow the profile even if Electron has already resolved sessionData.
    app.setPath("sessionData", devProfile);
  }
  return { isDev, effectiveDevServerUrl: isDev ? devServerUrl : undefined };
}

module.exports = { configureAppProfile };
