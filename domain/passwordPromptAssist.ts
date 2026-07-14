import type { Host, Identity, SSHKey } from "./models";
import { sanitizeCredentialValue } from "./credentials";
import { resolveHostAuth, resolveHostAutofillPassword } from "./sshAuth";

export type PasswordPromptFillCandidate = {
  id: string;
  source: "host" | "identity";
  label: string;
  username?: string;
  /** Sanitized plaintext. Callers must not log or render this in UI. */
  password: string;
};

const hostCandidateId = "host";
const identityCandidateId = (identityId: string) => `identity:${identityId}`;

/**
 * Build the credential list for sudo/su password-prompt assist (#2156).
 * Host session password first, then every decryptable keychain password
 * identity. Dedupes by password value so the same secret is not listed twice.
 */
export const listPasswordPromptFillCandidates = (args: {
  host: Host;
  keys: SSHKey[];
  identities?: Identity[];
}): PasswordPromptFillCandidate[] => {
  const candidates: PasswordPromptFillCandidate[] = [];
  const seenPasswords = new Set<string>();

  const push = (candidate: PasswordPromptFillCandidate) => {
    if (!candidate.password || seenPasswords.has(candidate.password)) return;
    seenPasswords.add(candidate.password);
    candidates.push(candidate);
  };

  // Same resolution path as login so group-inherited identities and identityId
  // references surface the correct username next to the session password.
  const resolvedAuth = resolveHostAuth(args);
  const hostPassword = resolveHostAutofillPassword(args);
  if (hostPassword) {
    const hostLabel =
      args.host.label?.trim()
      || args.host.hostname?.trim()
      || resolvedAuth.username?.trim()
      || args.host.username?.trim()
      || "Host";
    push({
      id: hostCandidateId,
      source: "host",
      label: hostLabel,
      username: resolvedAuth.username?.trim() || args.host.username?.trim() || undefined,
      password: hostPassword,
    });
  }

  const identities = args.identities ?? [];
  // Stable order: explicit order field, then created, then id.
  const ordered = [...identities].sort((a, b) => {
    const ao = a.order ?? Number.MAX_SAFE_INTEGER;
    const bo = b.order ?? Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    if (a.created !== b.created) return a.created - b.created;
    return a.id.localeCompare(b.id);
  });

  for (const identity of ordered) {
    if (identity.authMethod !== "password") continue;
    const password = sanitizeCredentialValue(identity.password);
    if (!password) continue;
    const label = identity.label?.trim() || identity.username?.trim() || identity.id;
    push({
      id: identityCandidateId(identity.id),
      source: "identity",
      label,
      username: identity.username?.trim() || undefined,
      password,
    });
  }

  return candidates;
};

/** Prefer host candidate password; fall back to first available candidate. */
export const resolveDefaultPasswordPromptFillPassword = (
  candidates: PasswordPromptFillCandidate[],
): string | undefined => {
  const host = candidates.find((c) => c.source === "host");
  return host?.password ?? candidates[0]?.password;
};
