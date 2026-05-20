const test = require("node:test");
const assert = require("node:assert/strict");

const { _shouldLogSshDebugMessage } = require("./sshBridge.cjs");

test("SSH debug logging keeps handshake and key exchange messages", () => {
  assert.equal(
    _shouldLogSshDebugMessage("Handshake: KEX algorithm: diffie-hellman-group-exchange-sha1"),
    true,
  );
  assert.equal(
    _shouldLogSshDebugMessage("Handshake: (remote) KEX method: diffie-hellman-group14-sha1"),
    true,
  );
  assert.equal(
    _shouldLogSshDebugMessage("Outbound: Sending KEXDH_GEX_REQUEST"),
    true,
  );
  assert.equal(
    _shouldLogSshDebugMessage("Received DH GEX Group"),
    true,
  );
  assert.equal(
    _shouldLogSshDebugMessage("Outbound: Sending NEWKEYS"),
    true,
  );
});

test("SSH debug logging keeps auth messages but drops noisy channel data", () => {
  assert.equal(
    _shouldLogSshDebugMessage("Outbound: Sending USERAUTH_REQUEST (publickey -- check)"),
    true,
  );
  assert.equal(
    _shouldLogSshDebugMessage("Inbound: Received CHANNEL_DATA"),
    false,
  );
  assert.equal(
    _shouldLogSshDebugMessage("Outbound: Sending CHANNEL_WINDOW_ADJUST"),
    false,
  );
});
