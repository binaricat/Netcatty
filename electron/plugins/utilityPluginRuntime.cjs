"use strict";

const { pathToFileURL } = require("node:url");
const fs = require("node:fs/promises");
const path = require("node:path");

const {
  PLUGIN_ACTIVATION_TIMEOUT_MS,
  PLUGIN_DEACTIVATION_TIMEOUT_MS,
  PLUGIN_UTILITY_FORCE_EXIT_TIMEOUT_MS,
  PLUGIN_UTILITY_TERMINATION_GRACE_MS,
} = require("./constants.cjs");
const { PluginRpcRouter } = require("./rpcRouter.cjs");
const {
  assertTerminalInterceptorAttachmentParams,
  assertTerminalInterceptorAttachmentResult,
} = require("./contractValidator.cjs");
const { isPathInside } = require("./paths.cjs");

const PLUGIN_CONTAINMENT_ERROR_CODE = "ERR_PLUGIN_RUNTIME_CONTAINMENT_FAILED";

function createContainmentError(message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = PLUGIN_CONTAINMENT_ERROR_CODE;
  return error;
}

async function resolveUtilityEntrypoint(packageRoot, packagePath) {
  const candidate = path.resolve(packageRoot, ...packagePath.split("/"));
  const [realRoot, realCandidate] = await Promise.all([fs.realpath(packageRoot), fs.realpath(candidate)]);
  if (!isPathInside(realRoot, realCandidate)) throw new Error("Plugin utility entrypoint escapes its package");
  const stats = await fs.lstat(realCandidate);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Plugin utility entrypoint is not a regular file");
  return realCandidate;
}

function waitForUtilityReady(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Plugin utility process did not become ready"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener("message", onMessage);
      child.removeListener("exit", onExit);
    };
    const onMessage = (event) => {
      const message = event?.data ?? event;
      if (message?.type !== "netcatty-plugin:ready") return;
      cleanup();
      resolve();
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`Plugin utility process exited during startup (${code})`));
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

function waitForExit(exitPromise, timeoutMs) {
  let timer;
  return Promise.race([
    exitPromise.then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

class UtilityPluginRuntime {
  constructor(options) {
    this.utilityProcess = options.utilityProcess;
    this.plugin = options.plugin;
    this.packageRoot = options.packageRoot;
    this.bootstrapPath = options.bootstrapPath;
    this.moduleMappings = options.moduleMappings;
    this.requestHandlers = options.requestHandlers ?? options.handlers;
    this.notificationHandlers = options.notificationHandlers ?? options.handlers;
    this.onIncomingStream = options.onIncomingStream;
    this.onBeforeMessage = options.onBeforeMessage;
    this.onProgress = options.onProgress;
    this.onProcessReady = options.onProcessReady ?? (() => {});
    this.logger = options.logger;
    this.onExit = options.onExit ?? (() => {});
    this.onProtocolError = options.onProtocolError ?? (() => {});
    this.forceKillProcess = options.forceKillProcess ?? ((pid) => process.kill(pid, "SIGKILL"));
    this.terminationGraceMs = options.terminationGraceMs ?? PLUGIN_UTILITY_TERMINATION_GRACE_MS;
    this.forceExitTimeoutMs = options.forceExitTimeoutMs ?? PLUGIN_UTILITY_FORCE_EXIT_TIMEOUT_MS;
    this.child = null;
    this.router = null;
    this.stopping = false;
    this.stopPromise = null;
    this.exitPromise = null;
    this.resolveExit = null;
    this.exited = false;
    this.terminationError = null;
    this.gracefulTerminationError = null;
    this.terminationRequested = false;
    this.terminationPromise = null;
    this.exitReported = false;
  }

  #assertStarting(signal) {
    signal?.throwIfAborted();
    if (this.stopping) throw new Error("Plugin utility runtime startup was stopped");
    if (this.terminationError) throw this.terminationError;
    if (this.exited) throw new Error("Plugin utility process exited during startup");
  }

  async start(runtimeConfig, options = {}) {
    const { signal, getActivationEnvironment } = options;
    this.#assertStarting(signal);
    if (!this.utilityProcess?.fork) throw new Error("Electron utility plugin runtime is unavailable");
    const entryUrl = pathToFileURL(await resolveUtilityEntrypoint(
      this.packageRoot,
      this.plugin.manifest.main.node,
    )).href;
    this.#assertStarting(signal);
    const config = { ...runtimeConfig, entryUrl, moduleMappings: this.moduleMappings };
    this.child = this.utilityProcess.fork(this.bootstrapPath, [], {
      cwd: this.packageRoot,
      env: {
        LANG: process.env.LANG ?? "C.UTF-8",
        LC_ALL: process.env.LC_ALL ?? "",
        PATH: process.env.PATH ?? "",
        TMPDIR: process.env.TMPDIR ?? "",
        TEMP: process.env.TEMP ?? "",
        TMP: process.env.TMP ?? "",
      },
      stdio: ["ignore", "pipe", "pipe"],
      serviceName: `Netcatty Plugin: ${this.plugin.id}`,
      allowLoadingUnsignedLibraries: false,
      disclaim: process.platform === "darwin",
    });
    this.onProcessReady();
    this.exitPromise = new Promise((resolve) => { this.resolveExit = resolve; });
    this.child.on("error", (_type, location) => {
      this.#beginTermination(new Error(`Plugin utility fatal error at ${location}`));
    });
    this.child.on("exit", (code) => this.#finishExit(code));
    this.child.stdout?.on("data", (chunk) => this.logger.write("info", "utility stdout", { output: String(chunk).slice(0, 8_192) }));
    this.child.stderr?.on("data", (chunk) => this.logger.write("warn", "utility stderr", { output: String(chunk).slice(0, 8_192) }));
    this.router = new PluginRpcRouter({
      pluginId: this.plugin.id,
      send: (message, transfer = []) => this.child?.postMessage(message, transfer),
      requestHandlers: this.requestHandlers,
      notificationHandlers: this.notificationHandlers,
      onBeforeMessage: this.onBeforeMessage,
      onIncomingStream: this.onIncomingStream,
      onProgress: this.onProgress,
      onProtocolError: (error) => {
        this.onProtocolError(error);
        this.#beginTermination(error);
      },
    });
    this.child.on("message", (event) => {
      const message = event?.data ?? event;
      if (message?.type === "netcatty-plugin:ready") return;
      this.router?.accept(message);
    });
    const ready = waitForUtilityReady(this.child, PLUGIN_ACTIVATION_TIMEOUT_MS);
    this.child.postMessage({ type: "netcatty-plugin:bootstrap", config });
    await ready;
    this.#assertStarting(signal);
    const initialized = await this.router.request("plugin.initialize", {
      netcattyVersion: config.netcattyVersion,
      apiVersion: config.apiVersion,
      supportedFeatures: config.supportedFeatures,
    }, { timeoutMs: PLUGIN_ACTIVATION_TIMEOUT_MS });
    this.#assertStarting(signal);
    const activationEnvironment = typeof getActivationEnvironment === "function"
      ? getActivationEnvironment()
      : config.environment;
    await this.router.request("plugin.activate", activationEnvironment == null
      ? {}
      : { environment: activationEnvironment }, { timeoutMs: PLUGIN_ACTIVATION_TIMEOUT_MS });
    this.#assertStarting(signal);
    return initialized;
  }

  stop() {
    this.stopPromise ??= this.#stop();
    return this.stopPromise;
  }

  async #stop() {
    this.stopping = true;
    try {
      await this.router?.request("plugin.deactivate", {}, { timeoutMs: PLUGIN_DEACTIVATION_TIMEOUT_MS });
    } finally {
      const router = this.router;
      this.router = null;
      router?.close();
      await this.#terminateAndWait();
    }
  }

  request(method, params, options) {
    if (!this.router) return Promise.reject(new Error("Plugin utility runtime is not connected"));
    return this.router.request(method, params, options);
  }

  notify(method, params) {
    if (!this.router) throw new Error("Plugin utility runtime is not connected");
    this.router.notify(method, params);
  }

  openStream(streamId, windowBytes, options) {
    if (!this.router) return Promise.reject(new Error("Plugin utility runtime is not connected"));
    return this.router.streams.openOutgoing(streamId, windowBytes, options);
  }

  attachTerminalInterceptor(descriptor, port) {
    if (!this.router) throw new Error("Plugin utility runtime is not connected");
    if (!port) throw new TypeError("Terminal interceptor port is required");
    const params = assertTerminalInterceptorAttachmentParams({ descriptor });
    return this.router.request("plugin.terminal.interceptor.attach", params, {
      timeoutMs: PLUGIN_ACTIVATION_TIMEOUT_MS,
      transfer: [port],
      validateResult(result) {
        assertTerminalInterceptorAttachmentResult(result);
        return undefined;
      },
    });
  }

  getProcessId() {
    return this.child?.pid ?? null;
  }

  #beginTermination(error) {
    this.terminationError ??= error;
    const router = this.router;
    this.router = null;
    router?.close(error);
    void this.#terminateAndWait().catch((terminationError) => {
      if (this.stopping || this.exitReported) return;
      this.exitReported = true;
      this.onExit({ expected: false, error: terminationError, containmentFailed: true });
    });
  }

  #requestTermination() {
    if (!this.child || this.exited || this.terminationRequested) return;
    this.terminationRequested = true;
    try {
      this.child.kill();
    } catch (error) {
      this.gracefulTerminationError = error;
    }
  }

  #terminateAndWait() {
    this.terminationPromise ??= this.#terminateAndWaitOnce();
    return this.terminationPromise;
  }

  async #terminateAndWaitOnce() {
    this.#requestTermination();
    if (!this.exitPromise || this.exited) return;
    if (await waitForExit(this.exitPromise, this.terminationGraceMs)) return;
    const pid = this.child?.pid;
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw createContainmentError(
        "Plugin utility process did not expose a valid PID for forced termination",
        this.gracefulTerminationError ?? undefined,
      );
    }
    try {
      this.forceKillProcess(pid);
    } catch (error) {
      if (error?.code !== "ESRCH") {
        throw createContainmentError("Plugin utility process could not be forcibly terminated", error);
      }
    }
    if (await waitForExit(this.exitPromise, this.forceExitTimeoutMs)) return;
    throw createContainmentError("Plugin utility process did not exit after forced termination");
  }

  #finishExit(code) {
    if (this.exited) return;
    this.exited = true;
    this.resolveExit?.(code);
    this.resolveExit = null;
    if (this.stopping || this.exitReported) return;
    this.exitReported = true;
    const error = this.terminationError ?? new Error(`Plugin utility exited (${code})`);
    const router = this.router;
    this.router = null;
    router?.close(error);
    this.onExit({ expected: false, error });
  }

}

module.exports = {
  PLUGIN_CONTAINMENT_ERROR_CODE,
  UtilityPluginRuntime,
  createContainmentError,
  resolveUtilityEntrypoint,
  waitForExit,
  waitForUtilityReady,
};
