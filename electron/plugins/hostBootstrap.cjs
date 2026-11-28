"use strict";

function startPluginHost(options) {
  // Normal builds run the browser-only plugin platform (advanced Node/utility
  // packages remain gated behind NETCATTY_PLUGIN_DEV=1 in hostService.cjs).
  // Allow an explicit NETCATTY_PLUGIN_DEV=0 kill switch to leave plugin data untouched.
  if (options.env?.NETCATTY_PLUGIN_DEV === "0") return null;

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
