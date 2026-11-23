import assert from "node:assert/strict";
import test from "node:test";
import { remoteSoftwareRequiresSingleChannel } from "./singleChannelSshBanner.shared.cjs";
import { sftpRequiresDedicatedLogin } from "./sftpDedicatedLogin";

test("network-device mode forces a dedicated SFTP login before any banner", () => {
  assert.equal(
    sftpRequiresDedicatedLogin({ host: { deviceType: "network" } }),
    true,
  );
  assert.equal(
    sftpRequiresDedicatedLogin({
      host: { deviceType: "network" },
      remoteSshVersion: "OpenSSH_9.6",
    }),
    true,
  );
  assert.equal(
    sftpRequiresDedicatedLogin({
      host: { deviceType: "network" },
      remoteSshVersion: "SSH-2.0-OpenSSH_for_Windows_9.5",
    }),
    true,
  );
});

test("Huawei dash and Ruijie banners force a dedicated SFTP login", () => {
  for (const remoteSshVersion of ["-", "SSH-2.0--", "SSH-1.99--", "RGOS_SSH", "SSH-2.0-RGOS_SSH"]) {
    assert.equal(
      sftpRequiresDedicatedLogin({
        host: { deviceType: "general" },
        remoteSshVersion,
      }),
      true,
      remoteSshVersion,
    );
  }
  // Huawei `-` must not become a global single-channel bastion token.
  assert.equal(remoteSoftwareRequiresSingleChannel("-"), false);
  assert.equal(remoteSoftwareRequiresSingleChannel("SSH-2.0--"), false);
});

test("other network-vendor banners force a dedicated SFTP login", () => {
  for (const remoteSshVersion of [
    "SSH-2.0-Cisco-1.25",
    "SSH-2.0-H3C-Comware-7.1.064",
    "SSH-2.0-ROSSSH",
  ]) {
    assert.equal(
      sftpRequiresDedicatedLogin({ host: { deviceType: "general" }, remoteSshVersion }),
      true,
      remoteSshVersion,
    );
  }
});

test("one-channel bastion banners still force a dedicated SFTP login", () => {
  for (const remoteSshVersion of [
    "BHostSSH_7.0",
    "SSH-2.0-TERM-SSHD",
    "CLOUDBILITY-4.14",
    "SSH-2.0-CloudLinker",
  ]) {
    assert.equal(
      sftpRequiresDedicatedLogin({ host: { deviceType: "general" }, remoteSshVersion }),
      true,
      remoteSshVersion,
    );
  }
});

test("ordinary SSH servers keep the shared terminal SFTP transport", () => {
  assert.equal(sftpRequiresDedicatedLogin({ host: { deviceType: "general" } }), false);
  assert.equal(sftpRequiresDedicatedLogin({ host: null }), false);
  assert.equal(sftpRequiresDedicatedLogin({}), false);
  for (const remoteSshVersion of ["OpenSSH_9.6", "SSH-2.0-OpenSSH_9.6", "JumpServer", ""]) {
    assert.equal(
      sftpRequiresDedicatedLogin({ host: { deviceType: "general" }, remoteSshVersion }),
      false,
      remoteSshVersion,
    );
  }
});
