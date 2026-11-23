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

test("first-open follow stays put when the terminal cwd is still an unresolved ~", async () => {
  const navigatedPaths: string[] = [];
  const connection = {
    id: "conn-1",
    hostId: "host-1",
    currentPath: "/root",
    homeDir: "/root",
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
      activeTerminalCwd: "~",
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
      onGetTerminalCwd: async () => "~",
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
  assert.equal(connection.currentPath, "/root");
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

test("regular follow waits for trusted live cwd instead of polling after command clear", async () => {
  // Regression for #3588: command submit clears cwd to null and schedules a
  // backend-strict probe. Auto-follow must not preferFreshBackend-poll in that
  // gap — that race aborted the navigate and left the panel stuck.
  const navigatedPaths: string[] = [];
  let probeCalls = 0;
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
  let activeTerminalCwd: string | null = "/home/alice";
  let activeTerminalCwdTrusted = false;
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
        // First-open may probe; keep the pane where it already is.
        return connection.currentPath;
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
  const probesAfterOpen = probeCalls;
  assert.ok(probesAfterOpen >= 1, "first-open sync still probes");
  assert.deepEqual(navigatedPaths, []);

  // Command-submit style clear: no trusted cwd yet.
  activeTerminalCwd = null;
  activeTerminalCwdTrusted = false;
  await act(async () => {
    renderer?.update(React.createElement(Probe));
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(probeCalls, probesAfterOpen, "regular follow must not poll while cwd is cleared");
  assert.deepEqual(navigatedPaths, []);

  // Post-command backend-strict (or OSC 7) publishes a trusted live cwd.
  activeTerminalCwd = "/etc";
  activeTerminalCwdTrusted = true;
  await act(async () => {
    renderer?.update(React.createElement(Probe));
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.deepEqual(navigatedPaths, ["/etc"]);
  assert.equal(probeCalls, probesAfterOpen, "trusted live cwd must navigate without another poll");
  await act(async () => renderer?.unmount());
});

const wslHost = {
  ...host,
  id: "wsl-ubuntu-22-04",
  protocol: "local",
  localShell: "wsl.exe",
  localShellArgs: ["-d", "Ubuntu-22.04"],
} as Host;
const wslRoot = "\\\\wsl.localhost\\Ubuntu-22.04";

async function mountLocalFollow(options: {
  wslLocalHost?: Host;
  followEnabled?: boolean;
  freshCwd?: string | null;
}) {
  const connection = {
    id: "local-conn",
    currentPath: options.wslLocalHost ? wslRoot : "C:\\Users\\trum",
    homeDir: "C:\\Users\\trum",
    status: "connected",
    isLocal: true,
  };
  const navigatedPaths: string[] = [];
  const requestedOptions: unknown[] = [];
  const sftpRef = {
    current: {
      leftPane: { connection, loading: false },
      navigateTo: async (_side: "left", path: string, navigation?: { shouldApply?: () => boolean }) => {
        if (navigation?.shouldApply && !navigation.shouldApply()) return "aborted" as const;
        navigatedPaths.push(path);
        connection.currentPath = path;
        return "reached" as const;
      },
    },
  };
  let activeTerminalCwd: string | null = null;
  let freshCwd = options.freshCwd ?? null;
  let actions: ReturnType<typeof useSftpFollowTerminalCwd>;
  const onGetTerminalCwd = async (request: unknown) => {
    requestedOptions.push(request);
    return freshCwd;
  };
  function Probe() {
    actions = useSftpFollowTerminalCwd({
      wslLocalHost: options.wslLocalHost,
      focusedSessionId: "local-terminal",
      activeTerminalCwd,
      activeTerminalCwdTrusted: !!activeTerminalCwd,
      canFollowTerminalCwd: true,
      connectionId: connection.id,
      connectionIsLocal: true,
      connectionLoading: false,
      connectionPath: connection.currentPath,
      connectionStatus: connection.status,
      effectiveFollowTerminalCwd: options.followEnabled ?? true,
      followTerminalCwdHost: options.wslLocalHost ?? null,
      hasActiveWork: false,
      isVisible: true,
      ownerPanelOpen: true,
      onGetTerminalCwd,
      onPendingFollowOverride: () => {},
      sftpRef,
    });
    return null;
  }
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(React.createElement(Probe)); });
  return {
    connection,
    navigatedPaths,
    requestedOptions,
    async updateCwd(cwd: string | null) {
      activeTerminalCwd = cwd;
      await act(async () => { renderer.update(React.createElement(Probe)); });
    },
    async goTo(cwd: string | null) {
      freshCwd = cwd;
      await act(async () => { await actions.handleGoToTerminalCwd(); });
    },
    async unmount() { await act(async () => renderer.unmount()); },
  };
}

test("WSL local first-open and auto-follow map cwd and preserve manually browsed paths", async () => {
  const pane = await mountLocalFollow({ wslLocalHost: wslHost, freshCwd: "/home/vastbase" });
  try {
    assert.deepEqual(pane.navigatedPaths, [`${wslRoot}\\home\\vastbase`]);
    assert.deepEqual(pane.requestedOptions, [{
      preferFreshBackend: true, allowRendererFallback: false, requireActiveShellCwd: true,
    }]);
    await pane.updateCwd("/etc");
    assert.deepEqual(pane.navigatedPaths, [`${wslRoot}\\home\\vastbase`, `${wslRoot}\\etc`]);
    pane.connection.currentPath = "D:\\manual";
    await pane.updateCwd("/etc");
    assert.equal(pane.navigatedPaths.length, 2, "mapped handled cwd must not recapture manual browsing");
    await pane.updateCwd("/mnt/c/Users/trum");
    assert.equal(pane.connection.currentPath, "C:\\Users\\trum");
  } finally { await pane.unmount(); }
});

test("manual WSL go-to maps Linux and drive mounts even with follow disabled", async () => {
  const pane = await mountLocalFollow({ wslLocalHost: wslHost, followEnabled: false });
  try {
    assert.deepEqual(pane.requestedOptions, []);
    await pane.goTo("/home/vastbase/project");
    assert.equal(pane.connection.currentPath, `${wslRoot}\\home\\vastbase\\project`);
    await pane.goTo("~/src");
    assert.equal(pane.connection.currentPath, `${wslRoot}\\home\\vastbase\\src`);
    await pane.goTo("/mnt/d/work");
    assert.equal(pane.connection.currentPath, "D:\\work");
    await pane.goTo(null);
    assert.equal(pane.navigatedPaths.length, 3, "no live cwd leaves the pane in place");
  } finally { await pane.unmount(); }
});

test("WSL without a real distro name skips Linux go-to instead of using the slug", async () => {
  const pane = await mountLocalFollow({
    wslLocalHost: { ...wslHost, localShellArgs: undefined }, followEnabled: false,
  });
  try {
    await pane.goTo("/home/vastbase");
    assert.deepEqual(pane.navigatedPaths, []);
    await pane.goTo("/mnt/c/Users/trum");
    assert.equal(pane.connection.currentPath, "C:\\Users\\trum");
  } finally { await pane.unmount(); }
});

test("ordinary local panes cannot first-open or auto-follow; manual Windows cwd still works", async () => {
  const pane = await mountLocalFollow({ freshCwd: "/home/vastbase" });
  try {
    assert.deepEqual(pane.requestedOptions, []);
    await pane.updateCwd("C:\\work");
    assert.deepEqual(pane.navigatedPaths, []);
    await pane.goTo("C:\\work");
    assert.deepEqual(pane.navigatedPaths, ["C:\\work"]);
  } finally { await pane.unmount(); }
});
