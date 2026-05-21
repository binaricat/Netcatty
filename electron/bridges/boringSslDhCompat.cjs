/**
 * BoringSSL Diffie-Hellman group compatibility shim.
 *
 * Electron ships with BoringSSL, which no longer exposes some standard MODP
 * groups through the *named* `crypto.createDiffieHellmanGroup()` API — notably
 * the 1024-bit Oakley Group 2 ("modp2") that backs the SSH
 * `diffie-hellman-group1-sha1` key exchange. ssh2 calls
 * `createDiffieHellmanGroup('modp2')` for that kex, so on Electron it throws
 * "Unknown DH group" and legacy network devices that only speak group1-sha1
 * cannot be reached (issue #1035).
 *
 * The underlying DH math still works on BoringSSL via `createDiffieHellman()`
 * with an explicit prime, so this shim wraps `createDiffieHellmanGroup` to fall
 * back to the well-known prime constants when (and only when) the runtime can't
 * resolve a group by name. On OpenSSL builds the original call succeeds and the
 * fallback is never used, so behavior is unchanged there.
 *
 * IMPORTANT: ssh2 destructures `createDiffieHellmanGroup` at module load, so this
 * must be installed BEFORE ssh2 (or any bridge that requires it) is loaded.
 */
const crypto = require("node:crypto");

// Standard MODP groups (RFC 2409 / RFC 3526), generator 2. These primes are
// public constants and are byte-identical to Node's built-in groups, so the
// fallback produces the exact same key exchange the named group would have.
// Only groups that a runtime might drop yet ssh2 still requests need to live
// here; modp14/16/18 remain available on BoringSSL so they are intentionally
// omitted.
const MODP_GROUP_PRIMES = {
  // Oakley Group 2 — RFC 2409, 1024-bit. ssh2: diffie-hellman-group1-sha1.
  modp2:
    "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1" +
    "29024E088A67CC74020BBEA63B139B22514A08798E3404DD" +
    "EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245" +
    "E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED" +
    "EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE65381" +
    "FFFFFFFFFFFFFFFF",
};
const MODP_GENERATOR = Buffer.from([0x02]);

function createGroupFromPrime(name) {
  const primeHex = MODP_GROUP_PRIMES[name];
  if (!primeHex) return null;
  return crypto.createDiffieHellman(Buffer.from(primeHex, "hex"), MODP_GENERATOR);
}

/**
 * Wrap `target.createDiffieHellmanGroup` so missing named groups fall back to an
 * explicit-prime DiffieHellman. Idempotent. Returns true if it installed the
 * shim, false if it was already installed (or there was nothing to wrap).
 * @param {{ createDiffieHellmanGroup?: Function }} [target] defaults to the crypto module
 */
function installBoringSslDhCompat(target = crypto) {
  const original = target.createDiffieHellmanGroup;
  if (typeof original !== "function" || original.__boringSslDhCompat) {
    return false;
  }

  const wrapped = function createDiffieHellmanGroup(name) {
    try {
      return original(name);
    } catch (err) {
      const fallback = createGroupFromPrime(name);
      if (!fallback) throw err;
      return fallback;
    }
  };
  wrapped.__boringSslDhCompat = true;

  try {
    target.createDiffieHellmanGroup = wrapped;
  } catch {
    // The property may be read-only on some runtimes; force it via defineProperty.
    Object.defineProperty(target, "createDiffieHellmanGroup", {
      value: wrapped,
      configurable: true,
      writable: true,
    });
  }
  return true;
}

module.exports = { installBoringSslDhCompat, createGroupFromPrime, MODP_GROUP_PRIMES };
