import type { Identity } from "./models";
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
