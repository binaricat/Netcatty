"use strict";

const { isPluginDevelopmentEnabled } = require("./constants.cjs");

function startPluginHost(options) {
  // The plugin platform is not shipping in this release. Keep its data
  // untouched and allow existing developer workflows to opt in as before.
  if (!isPluginDevelopmentEnabled(options.env)) return null;

  const reportFailure = (message, error) => {
    try { options.logger?.error?.(message, error); } catch {}
  };
  let service;
  try {
    service = options.createService();
    const initialization = Promise.resolve(service.manager.initialize());
    options.registerShutdown(() => service.manager.shutdown());
    void initialization.catch(async (error) => {
      reportFailure("[Plugins] Failed to initialize plugin host:", error);
      try {
        await service.manager.shutdown();
      } catch (shutdownError) {
        reportFailure("[Plugins] Failed to close unavailable plugin host:", shutdownError);
      }
    });
    return service;
  } catch (error) {
    reportFailure("[Plugins] Failed to create plugin host:", error);
    if (typeof service?.manager?.shutdown === "function") {
      try { void Promise.resolve(service.manager.shutdown()).catch(() => {}); } catch {}
    }
    return null;
  }
}

module.exports = { startPluginHost };
