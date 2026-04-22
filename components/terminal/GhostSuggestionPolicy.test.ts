import test from "node:test";
import assert from "node:assert/strict";

import { decideGhostSuggestion } from "./autocomplete/ghostSuggestionPolicy.ts";

test("keeps the active ghost suggestion while input still fits it", () => {
  const decision = decideGhostSuggestion("docker ps -a", "doc", "docker compose ls");

  assert.deepEqual(decision, { type: "keep" });
});

test("switches to a new suggestion once the active one no longer matches", () => {
  const decision = decideGhostSuggestion("docker ps -a", "dog", "dogstatsd");

  assert.deepEqual(decision, { type: "show", suggestion: "dogstatsd" });
});

test("hides the ghost when neither the active nor next suggestion matches", () => {
  const decision = decideGhostSuggestion("docker ps -a", "dog", null);

  assert.deepEqual(decision, { type: "hide" });
});
