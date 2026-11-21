"use strict";

/**
 * Vendor assistant service.
 *
 * One browser at a time: every call owns a browser process and they all share a
 * persistent profile, so overlapping calls would fight over the profile lock.
 * Both the renderer IPC surface and the external MCP surface funnel through this
 * single queue.
 */

const driver = require("./driver.cjs");

function createQueue() {
  let tail = Promise.resolve();
  return function enqueue(task) {
    const run = tail.then(task, task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

const enqueue = createQueue();

function optionalTimeout(value) {
  const parsed = Number(value);
  return parsed > 0 ? parsed : undefined;
}

async function askVendor(request = {}) {
  const vendor = typeof request.vendor === "string" ? request.vendor : "";
  const question = typeof request.question === "string" ? request.question : "";
  if (!vendor.trim()) return { ok: false, vendor, status: "no_assistant", error: "vendor is required" };
  if (!question.trim()) return { ok: false, vendor, status: "no_assistant", error: "question is required" };
  const timeoutMs = optionalTimeout(request.timeoutMs);
  return enqueue(async () => {
    try {
      return await driver.ask(vendor, question, { timeoutMs });
    } catch (error) {
      return { ok: false, vendor, status: "error", error: error instanceof Error ? error.message : String(error) };
    }
  });
}

async function openVendorLogin(request = {}) {
  const vendor = typeof request.vendor === "string" ? request.vendor : "";
  if (!vendor.trim()) return { ok: false, vendor, status: "no_assistant", error: "vendor is required" };
  const timeoutMs = optionalTimeout(request.timeoutMs);
  return enqueue(async () => {
    try {
      return await driver.openLogin(vendor, { timeoutMs });
    } catch (error) {
      return { ok: false, vendor, status: "error", error: error instanceof Error ? error.message : String(error) };
    }
  });
}

function listVendors() {
  try {
    return driver.status();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

module.exports = {
  askVendor,
  openVendorLogin,
  listVendors,
};
