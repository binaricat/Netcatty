"use strict";

function startPluginHost(options) {
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
