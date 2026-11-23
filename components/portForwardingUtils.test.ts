import assert from "node:assert/strict";
import test from "node:test";

import type { PortForwardingRule } from "../domain/models";
import en from "../application/i18n/locales/en";
import es from "../application/i18n/locales/es";
import zhCN from "../application/i18n/locales/zh-CN";
import zhTW from "../application/i18n/locales/zh-TW";
import ru from "../application/i18n/locales/ru";
import {
  buildRuleMappingSummaries,
  buildRuleSummary,
  getFormRows,
  stopRuntimeTunnelBeforeDelete,
} from "./port-forwarding/utils";

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
  for (const [locale, messages] of Object.entries({ en, es, zhCN, zhTW, ru })) {
    for (const key of [
      "pf.rule.summary.local",
      "pf.rule.summary.remote",
      "pf.rule.summary.dynamic",
      "pf.rule.summary.mapping",
      "pf.form.mappings",
      "pf.form.addMapping",
      "pf.form.mapping.localPort",
      "pf.form.mapping.remotePort",
      "pf.form.mapping.remove",
    ]) {
      assert.equal(typeof messages[key], "string", `${locale} is missing ${key}`);
      assert.notEqual(messages[key], "", `${locale} has empty ${key}`);
    }
  }
});

const multiRule: PortForwardingRule = {
  ...baseRule,
  mappings: [
    { localPort: 15432, remotePort: 5432 },
    { localPort: 18080, remotePort: 8080 },
    { localPort: 19090, remotePort: 9090 },
  ],
};

test("buildRuleMappingSummaries returns one line per mapping for multi-mapping rules", () => {
  assert.deepEqual(buildRuleMappingSummaries(t, multiRule), [
    "15432 -> db.internal:5432",
    "18080 -> db.internal:8080",
    "19090 -> db.internal:9090",
  ]);
});

test("buildRuleMappingSummaries falls back to the legacy summary for single-mapping rules", () => {
  assert.deepEqual(buildRuleMappingSummaries(t, baseRule), [
    "Local 127.0.0.1:15432 -> SSH tunnel -> db.internal:5432",
  ]);
  assert.deepEqual(
    buildRuleMappingSummaries(t, { ...baseRule, mappings: [{ localPort: 15432, remotePort: 5432 }] }),
    ["Local 127.0.0.1:15432 -> SSH tunnel -> db.internal:5432"],
  );
});

test("getFormRows prefers working rows and derives a single row from scalars", () => {
  assert.deepEqual(getFormRows({ localPort: 15432, remotePort: 5432 }), [
    { localPort: 15432, remotePort: 5432 },
  ]);
  assert.deepEqual(
    getFormRows({
      localPort: 15432,
      remotePort: 5432,
      mappingRows: [{ localPort: 1 }, { localPort: 2, remotePort: 3 }],
    }),
    [{ localPort: 1 }, { localPort: 2, remotePort: 3 }],
  );
});

test("delete always verifies backend cleanup and retains the rule on failure", async () => {
  let stopCalls = 0;
  assert.equal(await stopRuntimeTunnelBeforeDelete(
    "rule-1",
    async () => {
      stopCalls++;
      return { success: false };
    },
  ), false);
  assert.equal(stopCalls, 1);

  assert.equal(await stopRuntimeTunnelBeforeDelete(
    "rule-1",
    async () => {
      stopCalls++;
      return { success: true };
    },
  ), true);
  assert.equal(stopCalls, 2);
});
