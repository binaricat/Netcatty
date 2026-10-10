import test from "node:test";
import assert from "node:assert/strict";

import { getSnippetSuggestions } from "./autocomplete/snippetCompleter";
import type { Snippet } from "../../domain/models";

const snip = (over: Partial<Snippet>): Snippet => ({
  id: over.id ?? "s1",
  label: over.label ?? "deploy",
  command: over.command ?? "echo deploy",
  ...over,
});

test("matches by label prefix and carries the snippet + command preview", () => {
  const s = snip({ id: "a", label: "deploy", command: "kubectl apply -f .\nkubectl rollout status deploy" });
  const out = getSnippetSuggestions("dep", [s], {});
  assert.equal(out.length, 1);
  assert.equal(out[0].source, "snippet");
  assert.equal(out[0].displayText, "deploy");
  assert.equal(out[0].description, "kubectl apply -f .\nkubectl rollout status deploy");
  assert.equal(out[0].snippet?.id, "a");
});

test("matches by command first line", () => {
  const s = snip({ id: "b", label: "k8s", command: "kubectl get pods" });
  const out = getSnippetSuggestions("kubectl", [s], {});
  assert.equal(out.length, 1);
  assert.equal(out[0].snippet?.id, "b");
});

test("is case-insensitive and prefix outranks substring", () => {
  const a = snip({ id: "p", label: "Backup", command: "tar czf b.tgz ." });
  const b = snip({ id: "q", label: "db-backup", command: "pg_dump" });
  const out = getSnippetSuggestions("backup", [a, b], {});
  assert.deepEqual(out.map((o) => o.snippet?.id), ["p", "q"]);
});

test("filters by host targets when set", () => {
  const scoped = snip({ id: "t", label: "restart", command: "systemctl restart x", targets: ["host-2"] });
  const global = snip({ id: "g", label: "restart-all", command: "echo all" });
  assert.deepEqual(getSnippetSuggestions("restart", [scoped, global], { hostId: "host-1" }).map((o) => o.snippet?.id), ["g"]);
  assert.deepEqual(getSnippetSuggestions("restart", [scoped, global], { hostId: "host-2" }).map((o) => o.snippet?.id).sort(), ["g", "t"]);
});

test("filters dynamic group targets using nested host group membership", () => {
  const scoped = snip({
    id: "grouped",
    label: "deploy-group",
    targetGroups: ["Production"],
  });
  const mixed = snip({
    id: "mixed",
    label: "deploy-mixed",
    targets: ["host-explicit"],
    targetGroups: ["Staging"],
  });

  assert.deepEqual(
    getSnippetSuggestions("deploy", [scoped, mixed], {
      hostId: "host-prod",
      hostGroup: "Production/Web",
    }).map((item) => item.snippet?.id),
    ["grouped"],
  );
  assert.deepEqual(
    getSnippetSuggestions("deploy", [scoped, mixed], {
      hostId: "host-staging",
      hostGroup: "Staging/API",
    }).map((item) => item.snippet?.id),
    ["mixed"],
  );
  assert.deepEqual(
    getSnippetSuggestions("deploy", [scoped, mixed], {
      hostId: "host-dev",
      hostGroup: "Development",
    }),
    [],
  );
});

test("does not surface a snippet with an explicitly empty group scope", () => {
  const disabled = snip({
    id: "disabled-group-scope",
    label: "deploy-disabled",
    targetGroups: [],
  });
  assert.deepEqual(
    getSnippetSuggestions("deploy", [disabled], {
      hostId: "host-prod",
      hostGroup: "Production",
    }),
    [],
  );
});

test("no match returns empty; empty input returns empty", () => {
  assert.deepEqual(getSnippetSuggestions("zzz", [snip({})], {}), []);
  assert.deepEqual(getSnippetSuggestions("", [snip({})], {}), []);
});

test("matches Chinese labels by literal Chinese input", () => {
  const s = snip({ id: "zh", label: "部署服务", command: "kubectl apply -f ." });
  const out = getSnippetSuggestions("部署", [s], {});
  assert.equal(out.length, 1);
  assert.equal(out[0].snippet?.id, "zh");
  assert.equal(out[0].displayText, "部署服务");
});

test("matches Chinese labels by pinyin and initials (smart suggest)", () => {
  const s = snip({ id: "zh", label: "部署服务", command: "kubectl apply -f ." });
  assert.equal(getSnippetSuggestions("bushu", [s], {})[0]?.snippet?.id, "zh");
  assert.equal(getSnippetSuggestions("bsfw", [s], {})[0]?.snippet?.id, "zh");
});

test("prefixOnly mode matches at word boundaries (argument position, #3622)", () => {
  const s = snip({ id: "mail", label: "set-email", command: "git config user.email a@b.c" });
  // First 3 letters of the label's last word still match while typing an
  // argument, e.g. after `git pull `.
  assert.equal(getSnippetSuggestions("ema", [s], { prefixOnly: true })[0]?.snippet?.id, "mail");
  // Mid-word substrings do not match.
  const gmail = snip({ id: "gm", label: "gmail", command: "echo gmail" });
  assert.deepEqual(getSnippetSuggestions("mai", [gmail], { prefixOnly: true }), []);
});

test("prefixOnly mode matches Chinese labels via pinyin and initials", () => {
  const s = snip({ id: "zh", label: "部署服务", command: "kubectl apply" });
  assert.equal(getSnippetSuggestions("bush", [s], { prefixOnly: true })[0]?.snippet?.id, "zh");
  const mailbox = snip({ id: "yx", label: "邮箱", command: "user@example.com" });
  assert.equal(getSnippetSuggestions("yx", [mailbox], { prefixOnly: true })[0]?.snippet?.id, "yx");
});
