import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PORT_FORWARD_RECONNECT_BASE_DELAY_MS,
  PORT_FORWARD_RECONNECT_MAX_DELAY_MS,
  computePortForwardReconnectDelayMs,
  formatPortForwardReconnectMessage,
  isPortForwardingAutoReconnectEnabled,
  isPortForwardingNonRetryableError,
} from "./portForwardingReconnect";

describe("isPortForwardingAutoReconnectEnabled", () => {
  it("returns true when autoReconnect is enabled", () => {
    assert.equal(isPortForwardingAutoReconnectEnabled({ autoReconnect: true }), true);
  });

  it("returns true for auto-start rules (pre-existing behavior)", () => {
    assert.equal(isPortForwardingAutoReconnectEnabled({ autoStart: true }), true);
  });

  it("honors explicit disable even for auto-start rules", () => {
    assert.equal(isPortForwardingAutoReconnectEnabled({ autoStart: true, autoReconnect: false }), false);
  });

  it("returns false when neither flag opts in", () => {
    assert.equal(isPortForwardingAutoReconnectEnabled({}), false);
    assert.equal(isPortForwardingAutoReconnectEnabled({ autoStart: false }), false);
    assert.equal(isPortForwardingAutoReconnectEnabled({ autoReconnect: false }), false);
  });
});

describe("computePortForwardReconnectDelayMs", () => {
  it("doubles from 3s and caps at 60s", () => {
    assert.equal(computePortForwardReconnectDelayMs(1), 3_000);
    assert.equal(computePortForwardReconnectDelayMs(2), 6_000);
    assert.equal(computePortForwardReconnectDelayMs(3), 12_000);
    assert.equal(computePortForwardReconnectDelayMs(4), 24_000);
    assert.equal(computePortForwardReconnectDelayMs(5), 48_000);
    assert.equal(computePortForwardReconnectDelayMs(6), 60_000);
    assert.equal(computePortForwardReconnectDelayMs(7), 60_000);
    assert.equal(computePortForwardReconnectDelayMs(100), PORT_FORWARD_RECONNECT_MAX_DELAY_MS);
  });

  it("clamps invalid or non-positive attempt numbers to base delay", () => {
    assert.equal(computePortForwardReconnectDelayMs(0), PORT_FORWARD_RECONNECT_BASE_DELAY_MS);
    assert.equal(computePortForwardReconnectDelayMs(-5), PORT_FORWARD_RECONNECT_BASE_DELAY_MS);
    assert.equal(computePortForwardReconnectDelayMs(Number.NaN), PORT_FORWARD_RECONNECT_BASE_DELAY_MS);
    assert.equal(computePortForwardReconnectDelayMs(Number.POSITIVE_INFINITY), PORT_FORWARD_RECONNECT_BASE_DELAY_MS);
  });
});

describe("formatPortForwardReconnectMessage", () => {
  it("formats attempt count and backoff seconds", () => {
    assert.equal(
      formatPortForwardReconnectMessage(1, 3_000),
      "Reconnecting (attempt #1, next in 3s)...",
    );
    assert.equal(
      formatPortForwardReconnectMessage(6),
      "Reconnecting (attempt #6, next in 60s)...",
    );
  });
});

describe("isPortForwardingNonRetryableError", () => {
  it("classifies authentication, host key, bind conflict, and config errors as non-retryable", () => {
    const nonRetryableMessages = [
      "All configured authentication methods failed",
      "Authentication failed for user root",
      "Permission denied (publickey,password)",
      "Too many authentication failures",
      "Host denied (verification failed)",
      "Host key rejected for bastion.example.com",
      "Host key verification failed",
      "Host key mismatch",
      "ERR_HOST_KEY_UNVERIFIED",
      "listen EADDRINUSE: address already in use 127.0.0.1:8080",
      "listen EACCES: permission denied 0.0.0.0:80",
      "listen EADDRNOTAVAIL: cannot assign requested address 10.0.0.5:8080",
      "Cannot parse privateKey: Unsupported key format",
      "OpenSSH key integrity check failed -- bad passphrase?",
      "Encrypted private OpenSSH key detected, but no passphrase given",
      "Selected SSH key \"prod\" does not contain a private key",
      "ERR_PASSPHRASE_CANCELLED",
      "Saved proxy for host \"db\" is missing. Open host settings and select a valid proxy.",
      "Proxy identity for \"db\" is incomplete. Select an identity with a username and password, or enter proxy credentials manually.",
      "Missing jump host configuration for host chain: jump-1",
      "Saved credentials cannot be decrypted on this device. Open host settings and re-enter them.",
      "Unknown forwarding type: invalid",
      "Host not found",
      "Rule host is not configured",
      "Proxy or jump host configuration is not ready",
    ];
    for (const message of nonRetryableMessages) {
      assert.equal(
        isPortForwardingNonRetryableError(message),
        true,
        `expected non-retryable: ${message}`,
      );
    }
  });

  it("keeps transient network and transport errors retryable", () => {
    const retryableMessages: Array<string | null | undefined> = [
      undefined,
      null,
      "",
      "   ",
      "connect ECONNREFUSED 10.0.0.1:22",
      "read ECONNRESET",
      "connect ETIMEDOUT 10.0.0.1:22",
      "connect ENETUNREACH 10.0.0.1:22",
      "connect EHOSTUNREACH 10.0.0.1:22",
      "getaddrinfo ENOTFOUND example.com",
      "getaddrinfo EAI_AGAIN example.com",
      "Connection timeout to example.com",
      "Timed out while waiting for handshake",
      "Keepalive timeout",
      "SSH connection failed",
      "SSH connection closed before ready",
      "Tunnel pf-1-123 closed before connection established",
      "shared transport error",
      "connection lost",
      "connection closed",
      "offline socket",
      "listener close failed",
      "Unable to bind 0.0.0.0:8080 on remote server",
    ];
    for (const message of retryableMessages) {
      assert.equal(
        isPortForwardingNonRetryableError(message),
        false,
        `expected retryable: ${String(message)}`,
      );
    }
  });
});
