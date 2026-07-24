/**
 * Compare host address strings for vault list sorting.
 * IPv4 addresses sort numerically; everything else falls back to
 * case-insensitive numeric-aware string compare. IPv4 sorts before
 * non-IPv4 so mixed lists stay predictable.
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
