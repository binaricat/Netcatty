const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyInitialJmsDeepLinkPreference,
  applyInitialSshDeepLinkPreference,
  applyJmsProtocolClientPreference,
  applySshProtocolClientPreference,
  collectJmsDeepLinkUrls,
  collectSshDeepLinkUrls,
  collectTelnetDeepLinkUrls,
  isJmsDeepLinkUrl,
  isSshDeepLinkUrl,
  isTelnetDeepLinkUrl,
  readJmsDeepLinkEnabledPreference,
  readSshDeepLinkEnabledPreference,
  shouldDeliverJmsDeepLink,
  shouldDeliverSshDeepLink,
  updateJmsDeepLinkEnabledPreference,
  updateSshDeepLinkEnabledPreference,
  writeJmsDeepLinkEnabledPreference,
  writeSshDeepLinkEnabledPreference,
} = require("./deepLink.cjs");

test("isSshDeepLinkUrl accepts only ssh URLs", () => {
  assert.equal(isSshDeepLinkUrl("ssh://alice@example.com:2200"), true);
  assert.equal(isSshDeepLinkUrl("SSH://alice@example.com"), true);
  assert.equal(isSshDeepLinkUrl("ssh://example.com:99999"), true);
  assert.equal(isSshDeepLinkUrl("https://example.com"), false);
  assert.equal(isSshDeepLinkUrl("--flag"), false);
});

test("collectSshDeepLinkUrls extracts ssh URLs from process arguments", () => {
  assert.deepEqual(
    collectSshDeepLinkUrls([
      "/Applications/Netcatty.app/Contents/MacOS/Netcatty",
      "--flag",
      "ssh://alice@example.com",
      "file:///tmp/example",
      "ssh://bob@example.net:2222",
    ]),
    ["ssh://alice@example.com", "ssh://bob@example.net:2222"],
  );
});

test("applySshProtocolClientPreference registers or removes ssh and telnet handlers", () => {
  const calls = [];
  const app = {
    setAsDefaultProtocolClient: (...args) => {
      calls.push(["set", ...args]);
      return true;
    },
    removeAsDefaultProtocolClient: (...args) => {
      calls.push(["remove", ...args]);
      return true;
    },
  };

  assert.equal(applySshProtocolClientPreference({ app, enabled: true, isDev: false }), true);
  assert.equal(applySshProtocolClientPreference({ app, enabled: false, isDev: false }), true);
  assert.deepEqual(calls, [
    ["set", "ssh"],
    ["set", "telnet"],
    ["remove", "ssh"],
    ["remove", "telnet"],
  ]);
});

test("applySshProtocolClientPreference keeps ssh successful when telnet registration fails", () => {
  const calls = [];
  const app = {
    setAsDefaultProtocolClient: (protocol) => {
      calls.push(["set", protocol]);
      return protocol === "ssh";
    },
    removeAsDefaultProtocolClient: (protocol) => {
      calls.push(["remove", protocol]);
      return protocol === "ssh";
    },
  };

  assert.equal(applySshProtocolClientPreference({ app, enabled: true, isDev: false }), true);
  assert.equal(applySshProtocolClientPreference({ app, enabled: false, isDev: false }), true);
  assert.deepEqual(calls, [
    ["set", "ssh"],
    ["set", "telnet"],
    ["remove", "ssh"],
    ["remove", "telnet"],
  ]);
});

test("applySshProtocolClientPreference rolls back telnet registration when ssh enable fails", () => {
  const calls = [];
  const app = {
    setAsDefaultProtocolClient: (protocol) => {
      calls.push(["set", protocol]);
      return protocol === "telnet";
    },
    removeAsDefaultProtocolClient: (protocol) => {
      calls.push(["remove", protocol]);
      return true;
    },
  };

  assert.equal(applySshProtocolClientPreference({ app, enabled: true, isDev: false }), false);
  assert.deepEqual(calls, [
    ["set", "ssh"],
    ["set", "telnet"],
    ["remove", "telnet"],
  ]);
});

test("applySshProtocolClientPreference restores telnet registration when ssh disable fails", () => {
  const calls = [];
  const app = {
    setAsDefaultProtocolClient: (protocol) => {
      calls.push(["set", protocol]);
      return true;
    },
    removeAsDefaultProtocolClient: (protocol) => {
      calls.push(["remove", protocol]);
      return protocol === "telnet";
    },
  };

  assert.equal(applySshProtocolClientPreference({ app, enabled: false, isDev: false }), false);
  assert.deepEqual(calls, [
    ["remove", "ssh"],
    ["remove", "telnet"],
    ["set", "telnet"],
  ]);
});

test("isTelnetDeepLinkUrl accepts only telnet URLs", () => {
  assert.equal(isTelnetDeepLinkUrl("telnet://example.com:2001"), true);
  assert.equal(isTelnetDeepLinkUrl("TELNET://example.com:2001"), true);
  assert.equal(isTelnetDeepLinkUrl("ssh://alice@example.com"), false);
  assert.equal(isTelnetDeepLinkUrl("--flag"), false);
});

test("collectTelnetDeepLinkUrls extracts telnet URLs from process arguments", () => {
  assert.deepEqual(
    collectTelnetDeepLinkUrls([
      "/Applications/Netcatty.app/Contents/MacOS/Netcatty",
      "--flag",
      "telnet://example.com:2001",
      "file:///tmp/example",
      "telnet://router.local:23",
    ]),
    ["telnet://example.com:2001", "telnet://router.local:23"],
  );
});

test("ssh deep link enabled preference persists outside renderer localStorage", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-deeplink-"));
  const app = { getPath: () => userDataDir };

  assert.equal(readSshDeepLinkEnabledPreference({ app }), true);
  assert.equal(writeSshDeepLinkEnabledPreference({ app, enabled: false }), true);
  assert.equal(readSshDeepLinkEnabledPreference({ app }), false);
  assert.equal(writeSshDeepLinkEnabledPreference({ app, enabled: true }), true);
  assert.equal(readSshDeepLinkEnabledPreference({ app }), true);
});

test("updateSshDeepLinkEnabledPreference keeps the previous state when the system change fails", () => {
  const writes = [];
  const result = updateSshDeepLinkEnabledPreference({
    currentEnabled: true,
    enabled: false,
    applyPreference: () => false,
    writePreference: (enabled) => {
      writes.push(enabled);
      return true;
    },
  });

  assert.deepEqual(result, { enabled: true, success: false });
  assert.deepEqual(writes, []);
});

test("updateSshDeepLinkEnabledPreference clears queued links after disabling succeeds", () => {
  const writes = [];
  let cleared = false;
  const result = updateSshDeepLinkEnabledPreference({
    currentEnabled: true,
    enabled: false,
    applyPreference: () => true,
    writePreference: (enabled) => {
      writes.push(enabled);
      return true;
    },
    clearPending: () => {
      cleared = true;
    },
  });

  assert.deepEqual(result, { enabled: false, success: true });
  assert.deepEqual(writes, [false]);
  assert.equal(cleared, true);
});

test("updateSshDeepLinkEnabledPreference rolls back when saving the setting fails", () => {
  const applied = [];
  const result = updateSshDeepLinkEnabledPreference({
    currentEnabled: true,
    enabled: false,
    applyPreference: (enabled) => {
      applied.push(enabled);
      return true;
    },
    writePreference: () => false,
  });

  assert.deepEqual(result, { enabled: true, success: false });
  assert.deepEqual(applied, [false, true]);
});

test("updateSshDeepLinkEnabledPreference clears links when save and rollback both fail disabled", () => {
  const applied = [];
  let cleared = false;
  const result = updateSshDeepLinkEnabledPreference({
    currentEnabled: true,
    enabled: false,
    applyPreference: (enabled) => {
      applied.push(enabled);
      return enabled === false;
    },
    writePreference: () => false,
    clearPending: () => {
      cleared = true;
    },
  });

  assert.deepEqual(result, { enabled: false, success: false });
  assert.deepEqual(applied, [false, true]);
  assert.equal(cleared, true);
});

test("shouldDeliverSshDeepLink drops stale deliveries after the setting changes", () => {
  assert.equal(shouldDeliverSshDeepLink({
    enabled: true,
    deliveryGeneration: 1,
    expectedGeneration: 1,
  }), true);
  assert.equal(shouldDeliverSshDeepLink({
    enabled: false,
    deliveryGeneration: 1,
    expectedGeneration: 1,
  }), false);
  assert.equal(shouldDeliverSshDeepLink({
    enabled: true,
    deliveryGeneration: 2,
    expectedGeneration: 1,
  }), false);
});

test("applyInitialSshDeepLinkPreference disables handling when startup registration fails", () => {
  let cleared = false;
  const warnings = [];
  const result = applyInitialSshDeepLinkPreference({
    enabled: true,
    applyPreference: () => false,
    clearPending: () => {
      cleared = true;
    },
    logWarn: (message) => warnings.push(message),
  });

  assert.deepEqual(result, { enabled: false, success: false });
  assert.equal(cleared, true);
  assert.equal(warnings.length, 1);
});

test("isJmsDeepLinkUrl accepts only jms URLs", () => {
  assert.equal(isJmsDeepLinkUrl("jms://payload"), true);
  assert.equal(isJmsDeepLinkUrl("JMS://payload"), true);
  assert.equal(isJmsDeepLinkUrl("ssh://alice@example.com"), false);
  assert.equal(isJmsDeepLinkUrl("--flag"), false);
});

test("collectJmsDeepLinkUrls extracts jms URLs from process arguments", () => {
  assert.deepEqual(
    collectJmsDeepLinkUrls([
      "/Applications/Netcatty.app/Contents/MacOS/Netcatty",
      "--flag",
      "jms://payload-one",
      "file:///tmp/example",
      "jms://payload-two",
    ]),
    ["jms://payload-one", "jms://payload-two"],
  );
});

test("applyJmsProtocolClientPreference registers or removes the jms handler", () => {
  const calls = [];
  const app = {
    setAsDefaultProtocolClient: (...args) => {
      calls.push(["set", ...args]);
      return true;
    },
    removeAsDefaultProtocolClient: (...args) => {
      calls.push(["remove", ...args]);
      return true;
    },
  };

  assert.equal(applyJmsProtocolClientPreference({ app, enabled: true, isDev: false }), true);
  assert.equal(applyJmsProtocolClientPreference({ app, enabled: false, isDev: false }), true);
  assert.deepEqual(calls, [
    ["set", "jms"],
    ["remove", "jms"],
  ]);
});

test("jms deep link enabled preference defaults to disabled", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-jms-deeplink-"));
  const app = { getPath: () => userDataDir };

  assert.equal(readJmsDeepLinkEnabledPreference({ app }), false);
  assert.equal(writeJmsDeepLinkEnabledPreference({ app, enabled: true }), true);
  assert.equal(readJmsDeepLinkEnabledPreference({ app }), true);
  assert.equal(writeJmsDeepLinkEnabledPreference({ app, enabled: false }), true);
  assert.equal(readJmsDeepLinkEnabledPreference({ app }), false);
});

test("updateJmsDeepLinkEnabledPreference keeps the previous state when the system change fails", () => {
  const writes = [];
  const result = updateJmsDeepLinkEnabledPreference({
    currentEnabled: false,
    enabled: true,
    applyPreference: () => false,
    writePreference: (enabled) => {
      writes.push(enabled);
      return true;
    },
  });

  assert.deepEqual(result, { enabled: false, success: false });
  assert.deepEqual(writes, []);
});

test("updateJmsDeepLinkEnabledPreference clears queued links after disabling succeeds", () => {
  const writes = [];
  let cleared = false;
  const result = updateJmsDeepLinkEnabledPreference({
    currentEnabled: true,
    enabled: false,
    applyPreference: () => true,
    writePreference: (enabled) => {
      writes.push(enabled);
      return true;
    },
    clearPending: () => {
      cleared = true;
    },
  });

  assert.deepEqual(result, { enabled: false, success: true });
  assert.deepEqual(writes, [false]);
  assert.equal(cleared, true);
});

test("updateJmsDeepLinkEnabledPreference rolls back when saving the setting fails", () => {
  const applied = [];
  const result = updateJmsDeepLinkEnabledPreference({
    currentEnabled: false,
    enabled: true,
    applyPreference: (enabled) => {
      applied.push(enabled);
      return true;
    },
    writePreference: () => false,
  });

  assert.deepEqual(result, { enabled: false, success: false });
  assert.deepEqual(applied, [true, false]);
});

test("shouldDeliverJmsDeepLink drops stale deliveries after the setting changes", () => {
  assert.equal(shouldDeliverJmsDeepLink({
    enabled: true,
    deliveryGeneration: 1,
    expectedGeneration: 1,
  }), true);
  assert.equal(shouldDeliverJmsDeepLink({
    enabled: false,
    deliveryGeneration: 1,
    expectedGeneration: 1,
  }), false);
  assert.equal(shouldDeliverJmsDeepLink({
    enabled: true,
    deliveryGeneration: 2,
    expectedGeneration: 1,
  }), false);
});

test("applyInitialJmsDeepLinkPreference does not warn when disabled startup removal fails", () => {
  let cleared = false;
  const warnings = [];
  const result = applyInitialJmsDeepLinkPreference({
    enabled: false,
    applyPreference: () => false,
    clearPending: () => {
      cleared = true;
    },
    logWarn: (message) => warnings.push(message),
  });

  assert.deepEqual(result, { enabled: false, success: false });
  assert.equal(cleared, false);
  assert.equal(warnings.length, 0);
});
