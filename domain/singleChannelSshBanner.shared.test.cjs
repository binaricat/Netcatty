"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  remoteSoftwareRequiresSingleChannel,
  remoteDisallowsChunkedChannelWrite,
  optionsForPeerSingleChannel,
} = require("./singleChannelSshBanner.shared.cjs");

test("single-channel banners match only the observed software tokens", () => {
  for (const version of [
    "BHostSSH_7.0",
    "SSH-2.0-BHostSSH_7.0",
    "TERM-SSHD",
    "SSH-2.0-TERM-SSHD",
    "term-sshd",
    "CLOUDBILITY-4.14",
    "SSH-2.0-CLOUDBILITY-4.14",
  ]) {
    assert.equal(remoteSoftwareRequiresSingleChannel(version), true, version);
  }
});

test("single-channel banner match ignores OpenSSH, JumpServer, and lookalike tokens", () => {
  for (const version of [
    "",
    "   ",
    undefined,
    "OpenSSH_9.6",
    "SSH-2.0-OpenSSH_9.6",
    "OpenSSH_for_Windows_9.5",
    "dropbear_2024.85",
    "JumpServer",
    "SSH-2.0-JumpServer",
    "KoKo",
    "SSH-2.0-KOKO",
    "tsshd",
    "superterm-sshd",
    "cloudterm-sshd",
    "openterm-sshd",
    "CmdbHostSSH",
    "BHost",
    "notcloudbility",
  ]) {
    assert.equal(remoteSoftwareRequiresSingleChannel(version), false, String(version));
  }
});

test("chunked-write limit stays on BHostSSH and TERM-SSHD", () => {
  assert.equal(remoteDisallowsChunkedChannelWrite("BHostSSH_7.0"), true);
  assert.equal(remoteDisallowsChunkedChannelWrite("SSH-2.0-TERM-SSHD"), true);
  assert.equal(remoteDisallowsChunkedChannelWrite("CLOUDBILITY-4.14"), false);
  assert.equal(remoteDisallowsChunkedChannelWrite("OpenSSH_9.6"), false);
  assert.equal(remoteDisallowsChunkedChannelWrite("superterm-sshd"), false);
});

test("optionsForPeerSingleChannel stamps the runtime flag from the peer banner", () => {
  const requested = { hostname: "bastion", singleChannelSsh: false };
  const stamped = optionsForPeerSingleChannel(requested, { _remoteVer: "CLOUDBILITY-4.14" });
  assert.equal(stamped.singleChannelSsh, true);
  assert.equal(requested.singleChannelSsh, false);
  assert.equal(
    optionsForPeerSingleChannel(requested, { _remoteVer: "OpenSSH_9.6" }),
    requested,
  );
  assert.equal(
    optionsForPeerSingleChannel({ singleChannelSsh: true }, { _remoteVer: "OpenSSH_9.6" }).singleChannelSsh,
    true,
  );
});

test("CommonJS and renderer modules agree on SSH banner behavior", async () => {
  const browserModule = await import("./singleChannelSshBanner.shared.mjs");
  const nodeModule = require("./singleChannelSshBanner.shared.cjs");
  for (const version of [
    "BHostSSH_7.0", "TERM-SSHD", "CLOUDBILITY-4.14", "OpenSSH_9.6", "JumpServer", "",
  ]) {
    assert.equal(browserModule.remoteSoftwareRequiresSingleChannel(version), nodeModule.remoteSoftwareRequiresSingleChannel(version));
    assert.equal(browserModule.remoteDisallowsChunkedChannelWrite(version), nodeModule.remoteDisallowsChunkedChannelWrite(version));
    assert.deepEqual(
      browserModule.optionsForPeerSingleChannel({ singleChannelSsh: false }, { _remoteVer: version }),
      nodeModule.optionsForPeerSingleChannel({ singleChannelSsh: false }, { _remoteVer: version }),
    );
  }
});
