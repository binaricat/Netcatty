const test = require("node:test");
const assert = require("node:assert/strict");

const { utils } = require("ssh2");
const {
  prepareSystemSshAgent,
  resolveIdentityPath,
} = require("./systemSshAgent.cjs");

const TEST_PUBLIC_KEYS = [
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILKxGkTKkraRFbFuzZ2hIJiiRCVecNR1V0Az2YPSHyB1",
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKX948eIUbsCfpX6+wkEedowUaDcg9jZP0rAlCLfiPPY",
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFDTqolh2DHp5OhKylW13C0cZSwJ0pxzAWYoLsZR9VKE",
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGwNYEIS5fjDhPYDAeKd+osXu05BTlVfvlBGTpctoaWj",
];
let nextTestPublicKey = 0;

function makePublicKey() {
  const key = TEST_PUBLIC_KEYS[nextTestPublicKey % TEST_PUBLIC_KEYS.length];
  nextTestPublicKey += 1;
  return key;
}

function fakeAgent(publicKeys) {
  const identities = publicKeys.map((key) => utils.parseKey(key));
  return {
    getIdentities(callback) {
      callback(null, identities);
    },
    sign(_key, _data, _options, callback) {
      callback(null, Buffer.from("signature"));
    },
    getStream(callback) {
      callback(null, "forwarded-stream");
    },
  };
}

function getIdentities(agent) {
  return new Promise((resolve, reject) => {
    agent.getIdentities((error, identities) => {
      if (error) reject(error);
      else resolve(identities);
    });
  });
}

test("IdentityFile paths expand standard OpenSSH connection tokens", () => {
  const resolved = resolveIdentityPath(
    "%d/.ssh/key-%h-%p-%r-%u-%l-%L-%i-%%-%C",
    {
      hostname: "server.example.com",
      port: 2222,
      username: "deploy",
      localHostname: "mac.example.net",
      localUsername: "alice",
      uid: 501,
    },
  );

  assert.match(resolved, /key-server\.example\.com-2222-deploy-alice-mac\.example\.net-mac-501-%-[a-f0-9]{40}$/);
});

test("prepareSystemSshAgent prioritizes the identity selected by IdentityFile", async () => {
  const unrelated = makePublicKey();
  const selected = makePublicKey();
  const agent = await prepareSystemSshAgent({
    socketPath: "/tmp/agent.sock",
    identityFilePaths: ["/Users/alice/.ssh/aws_root"],
    identitiesOnly: false,
  }, {
    createAgent: () => fakeAgent([unrelated, selected]),
    readFile: async () => `${selected} alice@mac\n`,
    platform: "linux",
  });

  const identities = await getIdentities(agent);
  assert.deepEqual(
    identities.map((key) => key.getPublicSSH().toString("base64")),
    [selected, unrelated].map((key) => utils.parseKey(key).getPublicSSH().toString("base64")),
  );
  await new Promise((resolve, reject) => {
    agent.getStream((error, stream) => {
      if (error) reject(error);
      else {
        assert.equal(stream, "forwarded-stream");
        resolve();
      }
    });
  });
});

test("prepareSystemSshAgent excludes unrelated identities for IdentitiesOnly", async () => {
  const unrelated = makePublicKey();
  const selected = makePublicKey();
  const agent = await prepareSystemSshAgent({
    socketPath: "/tmp/agent.sock",
    identityFilePaths: ["/Users/alice/.ssh/aws_root"],
    identitiesOnly: true,
  }, {
    createAgent: () => fakeAgent([unrelated, selected]),
    readFile: async () => selected,
    platform: "linux",
  });

  const identities = await getIdentities(agent);
  assert.deepEqual(
    identities.map((key) => key.getPublicSSH().toString("base64")),
    [utils.parseKey(selected).getPublicSSH().toString("base64")],
  );
});

test("prepareSystemSshAgent filters by a selected vault public key", async () => {
  const unrelated = makePublicKey();
  const selected = makePublicKey();
  const agent = await prepareSystemSshAgent({
    socketPath: "/tmp/agent.sock",
    agentPublicKeys: [selected],
    identitiesOnly: true,
  }, {
    createAgent: () => fakeAgent([unrelated, selected]),
    platform: "linux",
  });

  const identities = await getIdentities(agent);
  assert.deepEqual(
    identities.map((key) => key.getPublicSSH().toString("base64")),
    [utils.parseKey(selected).getPublicSSH().toString("base64")],
  );
});

test("prepareSystemSshAgent asks macOS to load a missing configured identity from Keychain", async () => {
  const selected = makePublicKey();
  const sshAddCalls = [];

  await prepareSystemSshAgent({
    socketPath: "/private/tmp/agent.sock",
    identityFilePaths: ["/Users/alice/.ssh/aws_root"],
    identitiesOnly: true,
    useKeychain: true,
    addKeysToAgent: "yes",
  }, {
    createAgent: () => fakeAgent([]),
    readFile: async () => selected,
    runSshAdd: async (args) => sshAddCalls.push(args),
    platform: "darwin",
  });

  assert.deepEqual(sshAddCalls, [[
    "--apple-load-keychain",
    "/Users/alice/.ssh/aws_root",
  ]]);
});

test("prepareSystemSshAgent does not invoke macOS Keychain loading when the identity is already present", async () => {
  const selected = makePublicKey();
  const sshAddCalls = [];

  await prepareSystemSshAgent({
    socketPath: "/private/tmp/agent.sock",
    identityFilePaths: ["/Users/alice/.ssh/aws_root"],
    identitiesOnly: true,
    useKeychain: true,
    addKeysToAgent: "yes",
  }, {
    createAgent: () => fakeAgent([selected]),
    readFile: async () => selected,
    runSshAdd: async (args) => sshAddCalls.push(args),
    platform: "darwin",
  });

  assert.deepEqual(sshAddCalls, []);
});

test("prepareSystemSshAgent loads macOS Keychain when only some configured identities are present", async () => {
  const first = makePublicKey();
  const second = makePublicKey();
  const sshAddCalls = [];

  await prepareSystemSshAgent({
    socketPath: "/private/tmp/agent.sock",
    identityFilePaths: ["/Users/alice/.ssh/first", "/Users/alice/.ssh/second"],
    identitiesOnly: true,
    useKeychain: true,
    addKeysToAgent: "yes",
  }, {
    createAgent: () => fakeAgent([first]),
    readFile: async (publicKeyPath) => publicKeyPath.endsWith("first.pub") ? first : second,
    runSshAdd: async (args) => sshAddCalls.push(args),
    platform: "darwin",
  });

  assert.deepEqual(sshAddCalls, [[
    "--apple-load-keychain",
    "/Users/alice/.ssh/first",
    "/Users/alice/.ssh/second",
  ]]);
});

test("prepareSystemSshAgent does not bypass AddKeysToAgent confirmation policies", async () => {
  const selected = makePublicKey();
  const sshAddCalls = [];

  await prepareSystemSshAgent({
    socketPath: "/private/tmp/agent.sock",
    identityFilePaths: ["/Users/alice/.ssh/aws_root"],
    identitiesOnly: true,
    useKeychain: true,
    addKeysToAgent: "confirm",
  }, {
    createAgent: () => fakeAgent([]),
    readFile: async () => selected,
    runSshAdd: async (args) => sshAddCalls.push(args),
    platform: "darwin",
  });

  assert.deepEqual(sshAddCalls, []);
});

test("prepareSystemSshAgent reports a clear error when strict selection has no readable public key", async () => {
  await assert.rejects(
    prepareSystemSshAgent({
      socketPath: "/tmp/agent.sock",
      identityFilePaths: ["/Users/alice/.ssh/missing"],
      identitiesOnly: true,
    }, {
      createAgent: () => fakeAgent([makePublicKey()]),
      readFile: async () => { throw new Error("ENOENT"); },
      platform: "linux",
    }),
    (error) => {
      assert.equal(error.code, "ERR_SSH_AGENT_IDENTITY_SELECTOR_UNAVAILABLE");
      assert.match(error.message, /missing\.pub/);
      return true;
    },
  );
});

test("prepareSystemSshAgent reports every missing selector in strict multi-key mode", async () => {
  const selected = makePublicKey();
  await assert.rejects(
    prepareSystemSshAgent({
      socketPath: "/tmp/agent.sock",
      identityFilePaths: ["/Users/alice/.ssh/available", "/Users/alice/.ssh/missing"],
      identitiesOnly: true,
    }, {
      createAgent: () => fakeAgent([selected]),
      readFile: async (publicKeyPath) => {
        if (publicKeyPath.endsWith("available.pub")) return selected;
        throw new Error("ENOENT");
      },
      platform: "linux",
    }),
    (error) => {
      assert.equal(error.code, "ERR_SSH_AGENT_IDENTITY_SELECTOR_UNAVAILABLE");
      assert.match(error.message, /missing\.pub/);
      return true;
    },
  );
});

test("prepareSystemSshAgent falls back to all identities and still invokes macOS ssh-add without a .pub file", async () => {
  const loaded = makePublicKey();
  const sshAddCalls = [];
  const agent = await prepareSystemSshAgent({
    socketPath: "/private/tmp/agent.sock",
    identityFilePaths: ["/Users/alice/.ssh/aws_root"],
    identitiesOnly: false,
    useKeychain: true,
    addKeysToAgent: "yes",
  }, {
    createAgent: () => fakeAgent([loaded]),
    readFile: async () => { throw new Error("ENOENT"); },
    runSshAdd: async (args) => sshAddCalls.push(args),
    platform: "darwin",
  });

  assert.deepEqual(sshAddCalls, [[
    "--apple-load-keychain",
    "/Users/alice/.ssh/aws_root",
  ]]);
  assert.equal((await getIdentities(agent)).length, 1);
});
