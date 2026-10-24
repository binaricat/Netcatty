import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./PortForwardingNew.tsx", import.meta.url), "utf8");

test("port forwarding toolbar exposes start-all and stop-all actions", () => {
  assert.match(source, /pf\.action\.startAll/);
  assert.match(source, /pf\.action\.stopAll/);
  assert.match(source, /handleStartAll/);
  assert.match(source, /handleStopAll/);
  assert.match(source, /startAllTunnels/);
  assert.match(source, /stopAllTunnels/);
  assert.match(source, /startableRules\.length === 0/);
  assert.match(source, /stoppableRules\.length === 0/);
  assert.match(source, /<Play size=\{14\} \/>/);
  assert.match(source, /<Square size=\{14\} \/>/);
});

test("port forwarding bulk actions stay on start/stop all without selection checkboxes", () => {
  assert.match(source, /startAllTunnels\(/);
  assert.match(source, /stopAllTunnels\(/);
  assert.doesNotMatch(source, /selectedRuleIds|bulkDelete|type="checkbox"/);
});

test("port forwarding form supports multi-mapping rows with unique local ports", () => {
  const newFormSource = readFileSync(
    new URL("./port-forwarding/NewFormPanel.tsx", import.meta.url),
    "utf8",
  );
  const editPanelSource = readFileSync(
    new URL("./port-forwarding/EditPanel.tsx", import.meta.url),
    "utf8",
  );
  // Both form panels render the shared mapping rows editor.
  assert.match(newFormSource, /<MappingRows/);
  assert.match(editPanelSource, /<MappingRows/);
  // Draft carries working rows and validation rejects duplicate local ports.
  assert.match(source, /mappingRows: \[\{ localPort: undefined, remotePort: undefined \}\]/);
  assert.match(source, /seenLocalPorts\.has\(row\.localPort\)/);
  // Saving persists mappings only past one row; row 0 mirrors the scalars.
  assert.match(source, /mappings: rows\.map\(\(row\)/);
  // Editing a rule seeds rows from its mappings.
  assert.match(source, /getRuleMappings\(rule\)\.map/);
  // Rule cards receive per-mapping runtime states.
  assert.match(source, /getRuleMappingStates\(rule\.id\)/);
});

test("edit save and wizard validate and preserve mapping rows", () => {
  // Edit save applies the create-form row validation and disables Save until
  // it passes, so blank/duplicated ports cannot persist undefined mappings.
  assert.match(source, /isEditFormValid/);
  assert.match(source, /areMappingRowsValid\(editDraft\.type, rows\)/);
  assert.match(source, /saveDisabled=\{!isEditFormValid\(\)\}/);
  // The wizard keeps rows carried over from the form: its save converts them
  // into persisted mappings (row 0 folded from the wizard's scalar ports).
  assert.match(source, /getWizardMappingRows/);
  const saveRuleBody = source.slice(source.indexOf("const saveRule"));
  assert.match(saveRuleBody, /mappings: rows\.map\(\(row\)/);
});
