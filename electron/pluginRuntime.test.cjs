"use strict";

// Keep the plugin runtime suite in its own directory while preserving the
// repository's existing electron/*.test.cjs full-test discovery contract.
require("./plugins/database.test.cjs");
require("./plugins/browserPluginRuntime.test.cjs");
require("./plugins/hostRpcRegistry.test.cjs");
require("./plugins/hostBootstrap.test.cjs");
require("./plugins/hostService.test.cjs");
require("./plugins/contributionIconService.test.cjs");
require("./plugins/jsonBoundary.test.cjs");
require("./plugins/moduleResources.test.cjs");
require("./plugins/packageStore.test.cjs");
require("./plugins/packaging.test.cjs");
require("./plugins/paths.test.cjs");
require("./plugins/pluginBridge.test.cjs");
require("./plugins/pluginLogger.test.cjs");
require("./plugins/pluginManager.test.cjs");
require("./plugins/pluginProtocol.test.cjs");
require("./plugins/rpcRouter.test.cjs");
require("./plugins/runtimePeer.test.cjs");
require("./plugins/runtimeSupervisor.test.cjs");
require("./plugins/shutdownCoordinator.test.cjs");
require("./plugins/streamRouter.test.cjs");
require("./plugins/utilityPluginRuntime.test.cjs");

require('./plugins/brandIconService.test.cjs');

require('./plugins/settingsViewFixture.test.cjs');

require('./plugins/registryCatalogService.test.cjs');
