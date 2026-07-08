import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_REMEMBER_PASSPHRASE } from "./PassphraseModal.tsx";

test("passphrase remember checkbox defaults to unchecked for security", () => {
  assert.equal(DEFAULT_REMEMBER_PASSPHRASE, false);
});
