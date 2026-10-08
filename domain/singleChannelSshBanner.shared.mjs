"use strict";

// SSH software tokens that allow one session channel per TCP connection.
// Match the identification software token only. Do not match product names,
// OpenSSH, JumpServer/KoKo, or a "term-sshd" substring inside another token.
//
// BHostSSH_7.0 — issue #3146 log field remoteSshVersion. PR #3313: a second
// exec channel tears down the first interactive session. Multi-character
// channel writes are also dropped on this banner.
// TERM-SSHD — issue #2923 comment 5314292157 logs remoteSshVersion
// "TERM-SSHD". PR #3030: a later session channel on that TCP is accepted
// and the shell exits 0.
// CLOUDBILITY-4.14 — PR #3458 reproduction note: SSH-2.0-CLOUDBILITY-4.14
// drops the interactive shell when another session channel opens. No other
// public packet was found; do not add aliases.
// CloudLinker — issue #3592: the vendor identifies a single-channel gateway
// and proposes this distinctive banner. Older "Go" banners cannot identify it
// safely; this compatibility entry requires the vendor banner change.
// JumpServer KoKo advertises Version "JumpServer" and multiplexes. Omit it.

const SINGLE_CHANNEL_SOFTWARE_TOKENS = Object.freeze([
  "BHostSSH",
  "TERM-SSHD",
  "CLOUDBILITY",
  "CLOUDLINKER",
]);

// #3146 also drops multi-character writes. That evidence is only for these
// two tokens, not for CLOUDBILITY or CLOUDLINKER.
const CHUNKED_WRITE_SOFTWARE_TOKENS = Object.freeze([
  "BHostSSH",
  "TERM-SSHD",
]);

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function softwareTokenMatches(remoteSshVersion, token) {
  const software = String(remoteSshVersion || "").trim();
  if (!software) return false;
  const pattern = new RegExp(
    `(?:^|[^A-Za-z0-9])${escapeRegExp(token)}(?:[^A-Za-z0-9]|$)`,
    "i",
  );
  return pattern.test(software);
}

function remoteSoftwareMatchesAny(remoteSshVersion, tokens) {
  return tokens.some((token) => softwareTokenMatches(remoteSshVersion, token));
}

function remoteSoftwareRequiresSingleChannel(remoteSshVersion) {
  return remoteSoftwareMatchesAny(remoteSshVersion, SINGLE_CHANNEL_SOFTWARE_TOKENS);
}

function remoteDisallowsChunkedChannelWrite(remoteSshVersion) {
  return remoteSoftwareMatchesAny(remoteSshVersion, CHUNKED_WRITE_SOFTWARE_TOKENS);
}

function optionsForPeerSingleChannel(options, conn) {
  const remoteSshVersion = conn && typeof conn._remoteVer === "string" ? conn._remoteVer : "";
  if (!options || options.singleChannelSsh === true || !remoteSoftwareRequiresSingleChannel(remoteSshVersion)) {
    return options;
  }
  return { ...options, singleChannelSsh: true };
}

export {
  SINGLE_CHANNEL_SOFTWARE_TOKENS,
  remoteSoftwareRequiresSingleChannel,
  remoteDisallowsChunkedChannelWrite,
  optionsForPeerSingleChannel,
};
