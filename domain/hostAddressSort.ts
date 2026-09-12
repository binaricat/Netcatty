/**
 * Compare host address strings for vault list sorting.
 * IPv4 and IPv6 addresses sort numerically; hostnames fall back to
 * case-insensitive numeric-aware string compare. Mixed lists sort
 * IPv4 first, then IPv6, then hostnames.
 */
export function compareHostAddresses(left: string, right: string): number {
  const a = (left || "").trim().toLowerCase();
  const b = (right || "").trim().toLowerCase();
  if (a === b) return 0;

  const aV4 = parseIPv4Octets(a);
  const bV4 = parseIPv4Octets(b);

  if (aV4 && bV4) {
    for (let i = 0; i < 4; i += 1) {
      if (aV4[i] !== bV4[i]) return aV4[i] - bV4[i];
    }
    return 0;
  }
  if (aV4) return -1;
  if (bV4) return 1;

  const aV6 = parseIPv6Words(a);
  const bV6 = parseIPv6Words(b);
  if (aV6 && bV6) {
    for (let i = 0; i < 8; i += 1) {
      if (aV6[i] !== bV6[i]) return aV6[i] - bV6[i];
    }
    return 0;
  }
  if (aV6) return -1;
  if (bV6) return 1;

  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function parseIPv4Octets(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;

  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    // Reject leading zeros like "01" except a single "0"
    if (part.length > 1 && part.startsWith("0")) return null;
    octets.push(n);
  }
  return octets;
}

function parseIPv6Words(value: string): number[] | null {
  // Let the platform URL parser validate/canonicalize compressed and IPv4-mapped
  // IPv6. Zone identifiers identify an interface, not part of the IP value.
  const unwrapped = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  const address = unwrapped.split("%")[0];
  if (!address.includes(":") || !/^[0-9a-f:.]+$/.test(address)) return null;
  try {
    const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    const [left, right] = canonical.split("::");
    const head = left ? left.split(":") : [];
    const tail = right ? right.split(":") : [];
    const words = right === undefined ? head : [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail];
    return words.map(word => parseInt(word, 16));
  } catch {
    return null;
  }
}
