import type { Host, Identity } from "./models";
import { sanitizeCredentialValue } from "./credentials";

/**
 * Saved password identities that can be reused from the terminal
 * re-authentication dialog. Only identities carrying a usable stored
 * password and username qualify. Key identities are already selectable
 * through the existing SSH key picker (#3475). Undecryptable vault ciphertext
 * (`enc:v1:` placeholders left when hydration fails) is filtered out so
 * those identities fall back to manual password re-entry.
 */
export const listPasswordAuthIdentities = (
  identities: readonly Identity[] | undefined,
): Identity[] =>
  (identities ?? []).filter(
    (identity) =>
      identity.authMethod === "password"
      && typeof identity.username === "string"
      && identity.username.trim().length > 0
      && typeof identity.password === "string"
      && (sanitizeCredentialValue(identity.password) ?? "").length > 0,
  );

/** Use the temporary saved identity for SFTP opened from its authenticated terminal. */
export const resolvePasswordAuthSftpHost = (
  host: Host,
  identities: readonly Identity[] | undefined,
  auth: { authMethod: string; username: string; password?: string; savedToHost?: boolean } | null,
): Host => {
  if (!auth || auth.authMethod !== "password" || auth.savedToHost) return host;
  const identity = listPasswordAuthIdentities(identities).find(
    (candidate) => candidate.username === auth.username && candidate.password === auth.password,
  );
  return identity
    ? { ...host, username: identity.username, identityId: identity.id }
    : host;
};
