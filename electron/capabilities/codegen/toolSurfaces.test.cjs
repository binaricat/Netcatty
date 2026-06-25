"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { CAPABILITY_STATUS } = require("../constants.cjs");
const { ALL_CAPABILITIES } = require("../catalog/index.cjs");
const { TOOL_INPUT_FIELDS } = require("../schemas/toolInputs.cjs");
const {
  listMcpTools,
  listCattyToolSpecs,
  CATTY_CAPABILITY_DENYLIST,
  isCattyEligible,
} = require("./toolSurfaces.cjs");
const { registerMcpTools, buildZodShapeObject } = require("./mcpToolRegistry.cjs");

test("listCattyToolSpecs includes terminal long-running tools", () => {
  const specs = listCattyToolSpecs();
  const names = specs.map((spec) => spec.toolName);
  assert.ok(names.includes("terminal_execute"));
  assert.ok(names.includes("terminal_start"));
  assert.ok(names.includes("terminal_poll"));
  assert.ok(names.includes("terminal_stop"));
});

test("listCattyToolSpecs includes SFTP write tools and attachments", () => {
  const capabilityIds = listCattyToolSpecs().map((spec) => spec.capabilityId);
  assert.ok(capabilityIds.includes("attachment.list"));
  assert.ok(capabilityIds.includes("attachment.read"));
  assert.ok(capabilityIds.includes("sftp.write"));
  assert.ok(capabilityIds.includes("sftp.mkdir"));
  assert.ok(capabilityIds.includes("sftp.delete"));
  assert.ok(capabilityIds.includes("sftp.rename"));
  assert.ok(capabilityIds.includes("sftp.chmod"));
  assert.ok(!capabilityIds.includes("meta.status"));
  assert.ok(!capabilityIds.includes("session.cancel"));
});

test("listCattyToolSpecs includes vault host tools and SFTP transfer", () => {
  const capabilityIds = listCattyToolSpecs().map((spec) => spec.capabilityId);
  assert.ok(capabilityIds.includes("vault.host.get"));
  assert.ok(capabilityIds.includes("vault.host.list"));
  assert.ok(capabilityIds.includes("vault.hosts.create"));
  assert.ok(capabilityIds.includes("vault.host.import"));
  assert.ok(capabilityIds.includes("vault.note.create"));
  assert.ok(capabilityIds.includes("vault.note.list"));
  assert.ok(capabilityIds.includes("sftp.download"));
  assert.ok(capabilityIds.includes("sftp.upload"));
});

test("listCattyToolSpecs binds vault note tools to global RPC methods", () => {
  const specs = listCattyToolSpecs();
  const noteCreate = specs.find((spec) => spec.capabilityId === "vault.note.create");
  assert.equal(noteCreate?.rpcMethod, "vault/notes/create");
  const noteList = specs.find((spec) => spec.capabilityId === "vault.note.list");
  assert.equal(noteList?.rpcMethod, "vault/notes/list");
});

test("listCattyToolSpecs binds vault and portforward tools to global RPC methods", () => {
  const specs = listCattyToolSpecs();
  const hostNotesSet = specs.find((spec) => spec.capabilityId === "vault.host.notes.set");
  assert.equal(hostNotesSet?.rpcMethod, "vault/host/notes/set");
  const portforwardStart = specs.find((spec) => spec.capabilityId === "portforward.start");
  assert.equal(portforwardStart?.rpcMethod, "portforward/start");
});

test("listAgentToolSpecs splits sidebar harness tools from shared RPC tools", () => {
  const { AGENT_KINDS, listAgentToolSpecs } = require("./toolSurfaces.cjs");
  const sidebarIds = listAgentToolSpecs(AGENT_KINDS.SIDEBAR).map((spec) => spec.capabilityId);
  const globalIds = listAgentToolSpecs(AGENT_KINDS.GLOBAL).map((spec) => spec.capabilityId);

  assert.ok(sidebarIds.includes("harness.workspace.get_info"));
  assert.ok(!globalIds.includes("harness.workspace.get_info"));

  assert.ok(sidebarIds.includes("terminal.execute"));
  assert.ok(globalIds.includes("terminal.execute"));
  assert.ok(globalIds.includes("vault.note.create"));

  assert.ok(globalIds.every((id) => sidebarIds.includes(id) || id.startsWith("harness.") === false));
});

test("listCattyToolSpecs includes harness catty-only tools with local execution", () => {
  const specs = listCattyToolSpecs();
  assert.ok(specs.length >= 40);
  const harness = specs.filter((spec) => spec.capabilityId.startsWith("harness."));
  assert.equal(harness.length, 5);
  for (const spec of harness) {
    assert.equal(spec.localExecution, true);
    assert.equal(spec.rpcMethod, null);
  }
  const harnessIds = harness.map((spec) => spec.capabilityId);
  assert.ok(harnessIds.includes("harness.tool_output.read"));
  assert.ok(harnessIds.includes("harness.workspace.get_info"));
});

test("harness capabilities are not exposed on MCP", () => {
  const mcpCapabilityIds = listMcpTools().map((tool) => tool.capabilityId);
  for (const capabilityId of mcpCapabilityIds) {
    assert.ok(!capabilityId.startsWith("harness."));
  }
  assert.equal(listMcpTools().length, 35);
});

test("listMcpTools descriptions stay aligned with catalog capability ids", () => {
  const mcpTools = listMcpTools();
  assert.ok(mcpTools.length >= 35);
  for (const tool of mcpTools) {
    assert.ok(tool.capabilityId);
    assert.ok(tool.mcpTool);
    assert.ok(tool.description.length > 0);
    assert.ok(tool.rpcMethod);
  }
});

test("catty and mcp terminal tools share capability ids", () => {
  const catty = listCattyToolSpecs().find((spec) => spec.toolName === "terminal_execute");
  const mcp = listMcpTools().find((tool) => tool.mcpTool === "terminal_execute");
  assert.equal(catty?.capabilityId, "terminal.execute");
  assert.equal(mcp?.capabilityId, "terminal.execute");
});

test("implemented catalog tools with inputs are catty-eligible unless denylisted", () => {
  const implemented = ALL_CAPABILITIES.filter((cap) => cap.status === CAPABILITY_STATUS.IMPLEMENTED);
  for (const capability of implemented) {
    const hasInputs = Object.prototype.hasOwnProperty.call(TOOL_INPUT_FIELDS, capability.id);
    if (!hasInputs) continue;
    if (CATTY_CAPABILITY_DENYLIST.has(capability.id)) {
      assert.equal(isCattyEligible(capability), false);
      continue;
    }
    const hasRpc = Boolean(
      capability.surfaces?.builtin?.rpcMethod
      || capability.surfaces?.public?.mcpTool,
    );
    if (hasRpc) {
      assert.equal(isCattyEligible(capability), true);
    }
  }
});

test("mcp registry builds zod shapes for every MCP tool", () => {
  for (const tool of listMcpTools()) {
    const shape = buildZodShapeObject(tool.inputShape);
    assert.equal(typeof shape, "object");
  }
});

test("registerMcpTools registers one handler per catalog MCP tool", () => {
  const registered = [];
  const fakeServer = {
    tool(name, _description, _shape, handler) {
      registered.push({ name, handler: typeof handler });
    },
  };
  const count = registerMcpTools(fakeServer, {
    rpcCall: async () => ({ ok: true }),
    scopeParams: {},
    guardWriteOperation: () => null,
    catalogDescription: (_name, fallback) => fallback,
  });
  assert.equal(count, listMcpTools().length);
  assert.equal(registered.length, listMcpTools().length);
});
