import type { Identity } from "./models";

/**
 * Saved password identities that can be reused from the terminal
 * re-authentication dialog. Only identities carrying a usable stored
 * password qualify — key identities are already selectable through the
 * existing SSH key picker (#3475).
 */
export const listPasswordAuthIdentities = (
  identities: readonly Identity[] | undefined,
): Identity[] =>
  (identities ?? []).filter(
    (identity) =>
      identity.authMethod === "password"
      && typeof identity.password === "string"
      && identity.password.length > 0,
  );
