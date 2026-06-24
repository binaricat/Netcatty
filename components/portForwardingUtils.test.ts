import assert from "node:assert/strict";
import test from "node:test";

import type { PortForwardingRule } from "../domain/models";
import en from "../application/i18n/locales/en";
import zhCN from "../application/i18n/locales/zh-CN";
import ru from "../application/i18n/locales/ru";
import { buildRuleSummary } from "./port-forwarding/utils";

const interpolate = (template: string, vars?: Record<string, unknown>) =>
  template.replace(/\{(\w+)\}/g, (_, key) => String(vars?.[key] ?? ""));

const t = (key: string, vars?: Record<string, unknown>) => interpolate(en[key] ?? key, vars);

const baseRule: PortForwardingRule = {
  id: "rule-1",
  label: "Database tunnel",
  type: "local",
  hostId: "host-1",
  localPort: 15432,
  bindAddress: "127.0.0.1",
  remoteHost: "db.internal",
  remotePort: 5432,
  autoStart: false,
  status: "inactive",
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

test("buildRuleSummary describes local, remote, and dynamic forwarding directions separately", () => {
  assert.equal(
    buildRuleSummary(t, baseRule),
    "Local 127.0.0.1:15432 -> SSH tunnel -> db.internal:5432",
  );

  assert.equal(
    buildRuleSummary(t, { ...baseRule, type: "remote" }),
    "Remote 127.0.0.1:15432 -> SSH tunnel -> local db.internal:5432",
  );

  assert.equal(
    buildRuleSummary(t, { ...baseRule, type: "dynamic" }),
    "SOCKS on 127.0.0.1:15432",
  );
});

test("bundled locales include port forwarding summary copy for every forwarding type", () => {
  for (const [locale, messages] of Object.entries({ en, zhCN, ru })) {
    for (const key of [
      "pf.rule.summary.local",
      "pf.rule.summary.remote",
      "pf.rule.summary.dynamic",
    ]) {
      assert.equal(typeof messages[key], "string", `${locale} is missing ${key}`);
      assert.notEqual(messages[key], "", `${locale} has empty ${key}`);
    }
  }
});
