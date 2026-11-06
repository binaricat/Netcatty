"use strict";

const { createHash } = require("node:crypto");
const { isIP } = require("node:net");

const OFFICIAL_ORIGIN = "https://plugins.netcatty.app";
const OFFICIAL_SOURCE = Object.freeze({ id: "official", kind: "official", name: "Netcatty marketplace", origin: OFFICIAL_ORIGIN });
const LOCAL_SOURCE = Object.freeze({ id: "local", kind: "local", name: "Local import", origin: null });
// Curated first-party maintenance authority, independent of manifest publisher text.
const FIRST_PARTY_PLUGINS = Object.freeze([
  Object.freeze({ id: "com.netcatty.starter", repository: "binaricat/Netcatty" }),
  Object.freeze({ id: "com.netcatty.hello", repository: "binaricat/Netcatty" }),
]);
const hash = (value) => createHash("sha256").update(value).digest("hex");

// Source identity is host-owned. Neither a manifest nor a catalog supplies kind/id.
function canonicalSourceOrigin(value) {
  if (typeof value !== "string" || value.length > 2048 || /[\s\\%?#]/u.test(value)) throw new Error("Use a public HTTPS origin without credentials, query or fragment");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port
    || !["/", "/v1/snapshot.json"].includes(url.pathname)) throw new Error("Use an HTTPS origin or its /v1/snapshot.json endpoint");
  const hostname = url.hostname.toLowerCase();
  if (isIP(hostname) || hostname.includes(":") || !hostname.includes(".") || hostname.endsWith(".")
    || /(?:^|\.)(?:localhost|local|internal|invalid|test)$/u.test(hostname)) throw new Error("Market sources must use a public DNS hostname");
  // Explicitly reject textual credentials/normalization tricks before canonicalizing case.
  if (!/^https:\/\/[^/@]+(?:\/|\/v1\/snapshot\.json)?$/iu.test(value)) throw new Error("Invalid market source address");
  return url.origin;
}

function thirdPartySource(name, address) {
  if (typeof name !== "string" || !name.trim() || name.length > 100 || /[\u0000-\u001f\u007f]/u.test(name)) throw new Error("Source name must contain 1-100 printable characters");
  const origin = canonicalSourceOrigin(address);
  if (origin === OFFICIAL_ORIGIN) throw new Error("The official source is already built in");
  return Object.freeze({ id: `third-party:${hash(origin)}`, kind: "third-party", name: name.trim(), origin });
}

function assertSource(source) {
  if (!source || typeof source !== "object") throw new Error("Missing host source identity");
  const trusted = source.id === "official" ? OFFICIAL_SOURCE : source.id === "local" ? LOCAL_SOURCE : thirdPartySource(source.name, source.origin);
  if (["id", "kind", "origin"].some((key) => trusted[key] !== source[key])) throw new Error("Invalid host source identity");
  return { ...trusted };
}

function privateOwner(source, pluginId) {
  if (typeof pluginId !== "string" || !/^[a-z0-9][a-z0-9.-]{1,127}$/u.test(pluginId)) throw new Error("Invalid plugin identity");
  return `source:${hash(assertSource(source).id)}:${pluginId}`;
}

function isOfficialMaintained(entry, source) {
  const trusted = assertSource(source);
  return trusted.id === OFFICIAL_SOURCE.id && trusted.kind === OFFICIAL_SOURCE.kind
    && trusted.origin === OFFICIAL_SOURCE.origin
    && FIRST_PARTY_PLUGINS.some((pair) => pair.id === entry.id && pair.repository === entry.repository);
}

module.exports = { OFFICIAL_SOURCE, LOCAL_SOURCE, canonicalSourceOrigin, thirdPartySource, assertSource, privateOwner, isOfficialMaintained };
