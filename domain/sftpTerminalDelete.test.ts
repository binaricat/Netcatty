import test from "node:test";
import assert from "node:assert/strict";
import { resolveInteractiveTerminalDelete } from "./sftpTerminalDelete.ts";

test("resolveInteractiveTerminalDelete quotes one absolute path", () => {
  const plan = resolveInteractiveTerminalDelete([
    "/home/app/ai-zhiduoxing/static/zhiduoxing-user-frontend0921",
  ]);
  assert.ok(plan);
  assert.equal(
    plan.command,
    "rm -rf -- '/home/app/ai-zhiduoxing/static/zhiduoxing-user-frontend0921'",
  );
  assert.deepEqual(plan.directories, [
    {
      parentPath: "/home/app/ai-zhiduoxing/static",
      names: ["zhiduoxing-user-frontend0921"],
    },
  ]);
});

test("resolveInteractiveTerminalDelete keeps a single quote inside the quotes", () => {
  const plan = resolveInteractiveTerminalDelete(["/tmp/a" + "'" + "b"]);
  assert.ok(plan);
  assert.equal(plan.command.startsWith("rm -rf -- "), true);
  assert.equal(plan.command.includes("/tmp/a"), true);
  assert.equal(plan.command.includes("b"), true);
  assert.deepEqual(plan.directories[0].names, ["a" + "'" + "b"]);
});

test("resolveInteractiveTerminalDelete rejects unsafe paths", () => {
  assert.equal(resolveInteractiveTerminalDelete(["/"]), null);
  assert.equal(resolveInteractiveTerminalDelete(["relative"]), null);
  assert.equal(resolveInteractiveTerminalDelete(["/tmp/../etc"]), null);
  assert.equal(resolveInteractiveTerminalDelete(["/tmp/ok", "/bad/../x"]), null);
  assert.equal(resolveInteractiveTerminalDelete(["/tmp/has" + String.fromCharCode(10) + "line"]), null);
});
