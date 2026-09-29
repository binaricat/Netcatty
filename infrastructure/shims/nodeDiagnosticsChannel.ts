// @xterm/addon-ligatures bundles lru-cache, which imports
// node:diagnostics_channel for optional metrics. The renderer has no Node
// builtins. Nothing subscribes, so publish and tracePromise stay unused.

const silentChannel = {
  hasSubscribers: false,
  publish() {},
};

export function channel(): typeof silentChannel {
  return silentChannel;
}

export function tracingChannel(): {
  hasSubscribers: boolean;
  tracePromise: () => Promise<void>;
} {
  return {
    hasSubscribers: false,
    tracePromise() {
      return Promise.resolve();
    },
  };
}
