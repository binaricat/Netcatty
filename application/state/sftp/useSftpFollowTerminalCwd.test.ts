import assert from "node:assert/strict";
import test, { after } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { Host } from "../../../domain/models";
import { useSftpFollowTerminalCwd } from "./useSftpFollowTerminalCwd";

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
after(() => { actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment; });

const host = {
  id: "host-1",
  label: "Host",
  hostname: "example.com",
  port: 22,
  username: "alice",
  protocol: "ssh",
} as Host;

test("first-open follow uses a fresh terminal cwd instead of the cached home path", async () => {
  const requestedOptions: unknown[] = [];
  const navigatedPaths: string[] = [];
  const connection = {
    id: "conn-1",
    hostId: "host-1",
    currentPath: "/home/alice",
    status: "connected",
    isLocal: false,
  };
  const sftpRef = {
    current: {
      leftPane: { connection, loading: false },
      navigateTo: async (_side: "left", path: string, options?: { shouldApply?: () => boolean }) => {
        if (options?.shouldApply && !options.shouldApply()) return "aborted" as const;
        navigatedPaths.push(path);
        connection.currentPath = path;
        return "reached" as const;
      },
    },
  };
  let renderer: ReactTestRenderer | null = null;

  function Probe() {
    useSftpFollowTerminalCwd({
      activeSessionId: "session-1",
      activeTerminalCwd: "/home/alice",
      canFollowTerminalCwd: true,
      connectionId: connection.id,
      connectionIsLocal: connection.isLocal,
      connectionLoading: false,
      connectionPath: connection.currentPath,
      connectionStatus: connection.status,
      effectiveFollowTerminalCwd: true,
      followTerminalCwdHost: host,
      hasActiveWork: false,
      isVisible: true,
      ownerPanelOpen: true,
      onGetTerminalCwd: async (options) => {
        requestedOptions.push(options);
        return "/root/releases";
      },
      onPendingFollowOverride: () => {},
      sftpRef,
    });
    return null;
  }

  await act(async () => {
    renderer = create(React.createElement(Probe));
    await new Promise((resolve) => setImmediate(resolve));
  });

  assert.deepEqual(requestedOptions, [{
    preferFreshBackend: true,
    allowRendererFallback: false,
    requireActiveShellCwd: true,
  }]);
  assert.deepEqual(navigatedPaths, ["/root/releases"]);

  await act(async () => renderer?.unmount());
});

test("first-open follow does not use a stale cached cwd while the fresh probe is pending", async () => {
  let resolveCwd: ((cwd: string) => void) | null = null;
  const navigatedPaths: string[] = [];
  const connection = {
    id: "conn-1",
    hostId: "host-1",
    currentPath: "/srv/manual",
    status: "connected",
    isLocal: false,
  };
  const sftpRef = {
    current: {
      leftPane: { connection, loading: false },
      navigateTo: async (_side: "left", path: string) => {
        navigatedPaths.push(path);
        connection.currentPath = path;
        return "reached" as const;
      },
    },
  };
  let renderer: ReactTestRenderer | null = null;

  function Probe() {
    useSftpFollowTerminalCwd({
      activeSessionId: "session-1",
      activeTerminalCwd: "/home/alice",
      canFollowTerminalCwd: true,
      connectionId: connection.id,
      connectionIsLocal: connection.isLocal,
      connectionLoading: false,
      connectionPath: connection.currentPath,
      connectionStatus: connection.status,
      effectiveFollowTerminalCwd: true,
      followTerminalCwdHost: host,
      hasActiveWork: false,
      isVisible: true,
      ownerPanelOpen: true,
      onGetTerminalCwd: () => new Promise<string>((resolve) => { resolveCwd = resolve; }),
      onPendingFollowOverride: () => {},
      sftpRef,
    });
    return null;
  }

  await act(async () => {
    renderer = create(React.createElement(Probe));
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.deepEqual(navigatedPaths, []);

  await act(async () => {
    resolveCwd?.("/root/releases");
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.deepEqual(navigatedPaths, ["/root/releases"]);
  await act(async () => renderer?.unmount());
});

test("an in-flight first-open probe cannot navigate after Mosh focus changes", async () => {
  let resolveCwd: ((cwd: string) => void) | null = null;
  const navigatedPaths: string[] = [];
  const connection = {
    id: "conn-1",
    hostId: "host-1",
    currentPath: "/home/alice",
    status: "connected",
    isLocal: false,
  };
  const sftpRef = {
    current: {
      leftPane: { connection, loading: false },
      navigateTo: async (_side: "left", path: string, options?: { shouldApply?: () => boolean }) => {
        if (options?.shouldApply && !options.shouldApply()) return "aborted" as const;
        navigatedPaths.push(path);
        return "reached" as const;
      },
    },
  };
  let focusedSessionId: string | null = "mosh-a";
  let renderer: ReactTestRenderer | null = null;
  const onGetTerminalCwd = () => new Promise<string>((resolve) => { resolveCwd = resolve; });

  function Probe() {
    useSftpFollowTerminalCwd({
      activeSessionId: null,
      focusedSessionId,
      activeTerminalCwd: "/home/alice",
      canFollowTerminalCwd: true,
      connectionId: connection.id,
      connectionIsLocal: connection.isLocal,
      connectionLoading: false,
      connectionPath: connection.currentPath,
      connectionStatus: connection.status,
      effectiveFollowTerminalCwd: true,
      followTerminalCwdHost: host,
      hasActiveWork: false,
      isVisible: true,
      ownerPanelOpen: true,
      onGetTerminalCwd,
      onPendingFollowOverride: () => {},
      sftpRef,
    });
    return null;
  }

  await act(async () => {
    renderer = create(React.createElement(Probe));
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.ok(resolveCwd);

  focusedSessionId = "mosh-b";
  await act(async () => renderer?.update(React.createElement(Probe)));
  await act(async () => {
    resolveCwd?.("/root/from-mosh-a");
    await new Promise((resolve) => setImmediate(resolve));
  });

  assert.deepEqual(navigatedPaths, []);
  await act(async () => renderer?.unmount());
});

test("an in-flight first-open probe cannot move a pane after a hidden tab is restored", async () => {
  let resolveCwd: ((cwd: string) => void) | null = null;
  const navigatedPaths: string[] = [];
  const connection = {
    id: "conn-1",
    hostId: "host-1",
    currentPath: "/home/alice",
    status: "connected",
    isLocal: false,
  };
  const sftpRef = {
    current: {
      leftPane: { connection, loading: false },
      navigateTo: async (_side: "left", path: string) => {
        navigatedPaths.push(path);
        return "reached" as const;
      },
    },
  };
  let visible = true;
  let renderer: ReactTestRenderer | null = null;

  function Probe() {
    useSftpFollowTerminalCwd({
      activeSessionId: "session-1",
      activeTerminalCwd: "/home/alice",
      canFollowTerminalCwd: true,
      connectionId: connection.id,
      connectionIsLocal: connection.isLocal,
      connectionLoading: false,
      connectionPath: connection.currentPath,
      connectionStatus: connection.status,
      effectiveFollowTerminalCwd: true,
      followTerminalCwdHost: host,
      hasActiveWork: false,
      isVisible: visible,
      ownerPanelOpen: true,
      onGetTerminalCwd: () => new Promise<string>((resolve) => { resolveCwd = resolve; }),
      onPendingFollowOverride: () => {},
      sftpRef,
    });
    return null;
  }

  await act(async () => {
    renderer = create(React.createElement(Probe));
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.ok(resolveCwd);

  visible = false;
  await act(async () => renderer?.update(React.createElement(Probe)));
  visible = true;
  await act(async () => renderer?.update(React.createElement(Probe)));
  await act(async () => {
    resolveCwd?.("/root/releases");
    await new Promise((resolve) => setImmediate(resolve));
  });

  assert.deepEqual(navigatedPaths, []);
  await act(async () => renderer?.unmount());
});

test("an in-flight first-open probe cannot overwrite a manually browsed path", async () => {
  let resolveCwd: ((cwd: string) => void) | null = null;
  const navigatedPaths: string[] = [];
  const connection = {
    id: "conn-1",
    hostId: "host-1",
    currentPath: "/home/alice",
    status: "connected",
    isLocal: false,
  };
  const sftpRef = {
    current: {
      leftPane: { connection, loading: false },
      navigateTo: async (_side: "left", path: string) => {
        navigatedPaths.push(path);
        return "reached" as const;
      },
    },
  };
  let renderer: ReactTestRenderer | null = null;

  function Probe() {
    useSftpFollowTerminalCwd({
      activeSessionId: "session-1",
      activeTerminalCwd: "/home/alice",
      canFollowTerminalCwd: true,
      connectionId: connection.id,
      connectionIsLocal: connection.isLocal,
      connectionLoading: false,
      connectionPath: connection.currentPath,
      connectionStatus: connection.status,
      effectiveFollowTerminalCwd: true,
      followTerminalCwdHost: host,
      hasActiveWork: false,
      isVisible: true,
      ownerPanelOpen: true,
      onGetTerminalCwd: () => new Promise<string>((resolve) => { resolveCwd = resolve; }),
      onPendingFollowOverride: () => {},
      sftpRef,
    });
    return null;
  }

  await act(async () => {
    renderer = create(React.createElement(Probe));
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.ok(resolveCwd);

  connection.currentPath = "/srv/manual";
  await act(async () => {
    resolveCwd?.("/root/releases");
    await new Promise((resolve) => setImmediate(resolve));
  });

  assert.deepEqual(navigatedPaths, []);
  await act(async () => renderer?.unmount());
});

test("manual go-to-terminal-cwd cannot move a replacement connection", async () => {
  let resolveCwd: ((cwd: string) => void) | null = null;
  const navigatedPaths: string[] = [];
  let activeSessionId = "session-1";
  let connection = {
    id: "conn-1",
    hostId: "host-1",
    currentPath: "/home/alice",
    status: "connected",
    isLocal: false,
  };
  const sftpRef = {
    current: {
      leftPane: { connection, loading: false },
      navigateTo: async (_side: "left", path: string, options?: { shouldApply?: () => boolean }) => {
        if (options?.shouldApply && !options.shouldApply()) return "aborted" as const;
        navigatedPaths.push(path);
        return "reached" as const;
      },
    },
  };
  let actions: ReturnType<typeof useSftpFollowTerminalCwd> | null = null;
  let renderer: ReactTestRenderer | null = null;

  function Probe() {
    actions = useSftpFollowTerminalCwd({
      activeSessionId,
      activeTerminalCwd: null,
      canFollowTerminalCwd: false,
      connectionId: connection.id,
      connectionIsLocal: connection.isLocal,
      connectionLoading: false,
      connectionPath: connection.currentPath,
      connectionStatus: connection.status,
      effectiveFollowTerminalCwd: false,
      followTerminalCwdHost: host,
      hasActiveWork: false,
      isVisible: true,
      ownerPanelOpen: true,
      onGetTerminalCwd: () => new Promise<string>((resolve) => { resolveCwd = resolve; }),
      onPendingFollowOverride: () => {},
      sftpRef,
    });
    return null;
  }

  await act(async () => { renderer = create(React.createElement(Probe)); });
  assert.ok(actions);
  let navigationPromise: Promise<void> | undefined;
  await act(async () => {
    navigationPromise = actions?.handleGoToTerminalCwd();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.ok(resolveCwd);

  activeSessionId = "session-2";
  connection = { ...connection, id: "conn-2" };
  sftpRef.current.leftPane.connection = connection;
  await act(async () => renderer?.update(React.createElement(Probe)));
  await act(async () => {
    resolveCwd?.("/root/releases");
    await navigationPromise;
  });

  assert.deepEqual(navigatedPaths, []);
  await act(async () => renderer?.unmount());
});

test("only trusted live terminal cwd recovery resumes follow after initial probes are exhausted", async () => {
  const navigatedPaths: string[] = [];
  const connection = {
    id: "conn-1",
    hostId: "host-1",
    currentPath: "/srv/manual",
    status: "connected",
    isLocal: false,
  };
  const sftpRef = {
    current: {
      leftPane: { connection, loading: false },
      navigateTo: async (_side: "left", path: string) => {
        navigatedPaths.push(path);
        connection.currentPath = path;
        return "reached" as const;
      },
    },
  };
  let activeTerminalCwd = "/home/alice";
  let activeTerminalCwdTrusted = false;
  let probeCalls = 0;
  let renderer: ReactTestRenderer | null = null;

  function Probe() {
    useSftpFollowTerminalCwd({
      activeSessionId: "session-1",
      activeTerminalCwd,
      activeTerminalCwdTrusted,
      canFollowTerminalCwd: true,
      connectionId: connection.id,
      connectionIsLocal: connection.isLocal,
      connectionLoading: false,
      connectionPath: connection.currentPath,
      connectionStatus: connection.status,
      effectiveFollowTerminalCwd: true,
      followTerminalCwdHost: host,
      hasActiveWork: false,
      isVisible: true,
      ownerPanelOpen: true,
      onGetTerminalCwd: async () => {
        probeCalls += 1;
        return null;
      },
      onPendingFollowOverride: () => {},
      sftpRef,
    });
    return null;
  }

  await act(async () => {
    renderer = create(React.createElement(Probe));
    await new Promise((resolve) => setImmediate(resolve));
  });
  for (let attempt = 1; attempt < 3; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
  }
  assert.equal(probeCalls, 3);
  assert.deepEqual(navigatedPaths, []);

  activeTerminalCwd = null;
  await act(async () => renderer?.update(React.createElement(Probe)));
  activeTerminalCwd = "/home/alice";
  await act(async () => renderer?.update(React.createElement(Probe)));
  assert.deepEqual(navigatedPaths, [], "an untrusted restored snapshot must stay blocked");

  activeTerminalCwd = "/srv/new";
  activeTerminalCwdTrusted = true;
  await act(async () => {
    renderer?.update(React.createElement(Probe));
    await new Promise((resolve) => setImmediate(resolve));
  });

  assert.deepEqual(navigatedPaths, ["/srv/new"]);
  await act(async () => renderer?.unmount());
});

test("an in-flight follow probe cannot navigate after the focused session changes", async () => {
  const navigatedPaths: string[] = [];
  const connection = {
    id: "conn-1",
    hostId: "host-1",
    currentPath: "/home/alice",
    status: "connected",
    isLocal: false,
  };
  const sftpRef = {
    current: {
      leftPane: { connection, loading: false },
      navigateTo: async (_side: "left", path: string, options?: { shouldApply?: () => boolean }) => {
        if (options?.shouldApply && !options.shouldApply()) return "aborted" as const;
        navigatedPaths.push(path);
        connection.currentPath = path;
        return "reached" as const;
      },
    },
  };
  let activeSessionId = "session-a";
  let activeTerminalCwd: string | null = "/home/alice";
  let resolveCwd: ((cwd: string) => void) | null = null;
  let deferProbe = false;
  let renderer: ReactTestRenderer | null = null;
  const onGetTerminalCwd = () => {
    if (!deferProbe) return Promise.resolve("/root/session-a");
    return new Promise<string>((resolve) => { resolveCwd = resolve; });
  };

  function Probe() {
    useSftpFollowTerminalCwd({
      activeSessionId,
      activeTerminalCwd,
      canFollowTerminalCwd: true,
      connectionId: connection.id,
      connectionIsLocal: connection.isLocal,
      connectionLoading: false,
      connectionPath: connection.currentPath,
      connectionStatus: connection.status,
      effectiveFollowTerminalCwd: true,
      followTerminalCwdHost: host,
      hasActiveWork: false,
      isVisible: true,
      ownerPanelOpen: true,
      onGetTerminalCwd,
      onPendingFollowOverride: () => {},
      sftpRef,
    });
    return null;
  }

  await act(async () => {
    renderer = create(React.createElement(Probe));
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.deepEqual(navigatedPaths, ["/root/session-a"]);

  deferProbe = true;
  activeTerminalCwd = null;
  await act(async () => {
    renderer?.update(React.createElement(Probe));
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.ok(resolveCwd);

  activeSessionId = "session-b";
  await act(async () => renderer?.update(React.createElement(Probe)));
  await act(async () => {
    resolveCwd?.("/root/from-session-a");
    await new Promise((resolve) => setImmediate(resolve));
  });

  assert.deepEqual(navigatedPaths, ["/root/session-a"]);
  await act(async () => renderer?.unmount());
});
