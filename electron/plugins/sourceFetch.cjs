"use strict";

const dns = require("node:dns/promises");
const https = require("node:https");
const { BlockList, isIPv4 } = require("node:net");
const { Readable } = require("node:stream");
const { canonicalSourceOrigin } = require("./sourceIdentity.cjs");

const blocked = new BlockList();
for (const [address, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]]) blocked.addSubnet(address, prefix, "ipv4");
function isPublicAddress(address) { return isIPv4(address) && !blocked.check(address, "ipv4"); }

// This transport is deliberately separate from plugin network capability access.
// No cookies, credentials, redirects or proxy. DNS is validated and pinned to
// the actual connection, rather than checked separately before another lookup.
function createSourceFetch(origin, options = {}) {
  canonicalSourceOrigin(origin);
  const resolve4 = options.resolve4 ?? dns.resolve4;
  const request = options.request ?? https.get;
  return async (value, init = {}) => {
    const url = new URL(value);
    if (url.origin !== origin || url.username || url.password || url.search || url.hash
      || /[\\%\s]/u.test(value) || url.href !== value
      || !/^\/(?:v1\/snapshot\.json|snapshots\/[a-f0-9]{64}\/(?:catalog|index|delivery)\.json|assets\/[a-f0-9]{64}\.(?:md|png|webp|ncpkg))$/u.test(url.pathname)) throw new Error("Source resource is outside its static origin or protocol paths");
    init.signal?.throwIfAborted();
    // IPv4-only initial transport: IPv6-only sources fail visibly, never fall
    // back to an unchecked resolver. This keeps address classification explicit.
    const addresses = await new Promise((resolve, reject) => {
      const abort = () => reject(init.signal.reason);
      init.signal?.addEventListener("abort", abort, { once: true });
      Promise.resolve().then(() => resolve4(url.hostname)).then(resolve, reject)
        .finally(() => init.signal?.removeEventListener("abort", abort));
    });
    init.signal?.throwIfAborted();
    if (!addresses.length || addresses.some((address) => !isPublicAddress(address))) throw new Error("Source DNS resolves to a non-public address");
    const address = addresses[0];
    return new Promise((resolve, reject) => {
      const req = request(url, {
        agent: false, signal: init.signal,
        lookup(_host, opts, callback) {
          if (opts?.all) callback(null, [{ address, family: 4 }]);
          else callback(null, address, 4);
        },
        headers: { accept: "application/json, text/plain, application/octet-stream" },
      }, (response) => {
        try {
          const status = response.statusCode ?? 502;
          // fetchBounded rejects redirects/non-2xx and cancels the stream.
          const headers = new Headers();
          for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
          if ([204, 205, 304].includes(status)) { response.destroy(); resolve(new Response(null, { status, headers })); }
          else resolve(new Response(Readable.toWeb(response), { status, headers }));
        } catch (error) { response.destroy(); reject(error); }
      });
      req.once("error", reject);
    });
  };
}
module.exports = { createSourceFetch, isPublicAddress };
