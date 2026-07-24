import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readFunctionBody = (source: string, marker: string): string => {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${marker} must exist`);

  const bodyStart = source.indexOf("{", start);
  assert.notEqual(bodyStart, -1, `${marker} must have a body`);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(bodyStart, index + 1);
      }
    }
  }

  assert.fail(`${marker} body must close`);
};

test("full hibernate flushes pending hidden output before taking the snapshot", () => {
  const source = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");
  const body = readFunctionBody(source, "const fullHibernateRuntime = useCallback(async (): Promise<boolean> =>");

  const termCaptureIndex = body.indexOf("const term = termRef.current");
  const clearHiddenIndex = body.indexOf("terminalHiddenRendererStore.clearSoftHidden(sessionId)");
  const flushIndex = body.indexOf("flushPendingTerminalWritesBeforeHibernate(term)");
  const retryIndex = body.indexOf("scheduleHibernateRetry()");
  const alternateScreenSkipIndex = body.indexOf("shouldSkipHibernateForActiveAlternateScreen(term)");
  const snapshotIndex = body.indexOf("serializeTerminalForHibernate(");
  const releaseIndex = body.indexOf("releaseTerminalFlowBeforeHibernate(terminalBackend, term, backendId)");

  assert.notEqual(termCaptureIndex, -1, "hibernate must capture the active terminal once");
  assert.notEqual(clearHiddenIndex, -1, "hibernate must clear hidden renderer state");
  assert.notEqual(flushIndex, -1, "hibernate must flush pending terminal writes completely");
  assert.notEqual(retryIndex, -1, "hibernate must retry when pending writes are still draining");
  assert.notEqual(alternateScreenSkipIndex, -1, "hibernate must re-check alternate screen after draining output");
  assert.notEqual(snapshotIndex, -1, "hibernate must serialize a terminal snapshot");
  assert.notEqual(releaseIndex, -1, "hibernate must release flow after snapshot");
  assert.ok(termCaptureIndex < flushIndex, "flush must use the captured terminal");
  assert.ok(clearHiddenIndex < flushIndex, "clear hidden state before flushing pending writes");
  assert.ok(flushIndex < retryIndex, "retry can only be scheduled after the drain attempt");
  assert.ok(retryIndex < snapshotIndex, "retry branch must happen before snapshot");
  assert.ok(flushIndex < alternateScreenSkipIndex, "alternate screen must be checked after pending writes are drained");
  assert.ok(retryIndex < alternateScreenSkipIndex, "retry branch must run before the alternate-screen re-check");
  assert.ok(alternateScreenSkipIndex < snapshotIndex, "alternate-screen skip must happen before snapshot");
  assert.ok(flushIndex < snapshotIndex, "flush pending writes before snapshot");
  assert.ok(snapshotIndex < releaseIndex, "release flow only after snapshot");
});

test("live context reads flush pending hidden output before reading the buffer", () => {
  const source = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");
  const body = readFunctionBody(
    source,
    "const readTerminalContext = useCallback<TerminalContextReader>(async (request) =>",
  );

  const flushIndex = body.indexOf("await flushPendingTerminalWritesBeforeHibernate(targetTerm)");
  const drainGuardIndex = body.indexOf("if (!flushed)");
  const bufferReadIndex = body.indexOf("term.buffer.active");

  assert.notEqual(flushIndex, -1, "context reads must flush pending terminal writes");
  assert.notEqual(drainGuardIndex, -1, "context reads must reject an incomplete drain");
  assert.notEqual(bufferReadIndex, -1, "context reads must inspect the live terminal buffer");
  assert.ok(flushIndex < drainGuardIndex, "check the drain result after flushing");
  assert.ok(flushIndex < bufferReadIndex, "flush pending writes before reading the live buffer");
});

test("hibernate retry preserves normal hibernate blockers", () => {
  const source = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");
  const body = readFunctionBody(source, "const scheduleHibernateRetry = useCallback(() =>");

  const searchBlockerIndex = body.indexOf("isSearchOpenRef.current");
  const transferBlockerIndex = body.indexOf("hibernateFileTransferActiveRef.current");
  const retryIndex = body.indexOf("fullHibernateRuntimeRef.current?.()");

  assert.notEqual(searchBlockerIndex, -1, "retry must skip hibernate while search is open");
  assert.notEqual(transferBlockerIndex, -1, "retry must skip hibernate while file transfer is active");
  assert.notEqual(retryIndex, -1, "retry must be able to resume hibernation");
  assert.ok(searchBlockerIndex < retryIndex, "search blocker must run before retrying hibernate");
  assert.ok(transferBlockerIndex < retryIndex, "file-transfer blocker must run before retrying hibernate");
});

test("full hibernate rechecks live state after every asynchronous step", () => {
  const source = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");
  const body = readFunctionBody(source, "const fullHibernateRuntime = useCallback(async (): Promise<boolean> =>");

  const flushIndex = body.indexOf("await flushPendingTerminalWritesBeforeHibernate(term)");
  const afterFlushGuardIndex = body.indexOf("if (!canFinishHibernate()) return false;", flushIndex);
  const serializeIndex = body.indexOf("await serializeTerminalForHibernate(");
  const afterSerializeGuardIndex = body.indexOf("if (!canFinishHibernate()) return false;", serializeIndex);
  const releaseIndex = body.indexOf("releaseTerminalFlowBeforeHibernate(terminalBackend, term, backendId)");

  assert.match(body, /!isVisibleRef\.current/);
  assert.match(body, /hibernateEnabledRef\.current/);
  assert.match(body, /termRef\.current === term/);
  assert.match(body, /sessionRef\.current === backendId/);
  assert.ok(flushIndex < afterFlushGuardIndex, "visibility and settings must be rechecked after draining output");
  assert.ok(afterFlushGuardIndex < serializeIndex, "the post-drain guard must run before serialization");
  assert.ok(serializeIndex < afterSerializeGuardIndex, "visibility and settings must be rechecked after serialization");
  assert.ok(afterSerializeGuardIndex < releaseIndex, "the final guard must run before releasing the live runtime");
});

test("a cancelled soft-hidden upgrade resumes its renderer", () => {
  const source = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");
  const subscribeIndex = source.indexOf("terminalHiddenRendererStore.subscribe");
  const wakeIndex = source.indexOf("wakeSoftHiddenRuntime()", subscribeIndex);
  const upgradeIndex = source.indexOf("fullHibernateRuntime().then(", subscribeIndex);
  const cancelResumeIndex = source.indexOf("resumeRendererAfterCancelledHibernateUpgrade()", upgradeIndex);
  const helperBody = readFunctionBody(source, "const resumeRendererAfterCancelledHibernateUpgrade = useCallback(() =>");

  assert.notEqual(wakeIndex, -1, "soft-hidden eviction must resume the renderer before upgrading");
  assert.notEqual(upgradeIndex, -1, "soft-hidden eviction must await the full hibernate result");
  assert.ok(wakeIndex < upgradeIndex, "the renderer must be live throughout the asynchronous upgrade");
  assert.notEqual(cancelResumeIndex, -1, "a cancelled upgrade must resume the suspended renderer");
  assert.match(helperBody, /ensureWebglRenderer\(\)/);
  assert.match(helperBody, /clearTextureAtlas\(\)/);
  assert.match(helperBody, /safeFitRef\.current\(\{ force: true \}\)/);
});

test("snapshot and handoff paths reject output that misses the settle deadline", () => {
  const source = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");

  const drainWarningIndex = source.indexOf("Terminal output drain did not settle before the deadline");
  const drainReturnIndex = source.indexOf("return;", drainWarningIndex);
  const drainResponseIndex = source.indexOf("respondTerminalOutputDrain", drainReturnIndex);
  assert.ok(drainWarningIndex >= 0 && drainWarningIndex < drainReturnIndex);
  assert.ok(drainReturnIndex < drainResponseIndex);

  const snapshotWarningIndex = source.indexOf("Terminal snapshot drain did not settle before the deadline");
  const snapshotReturnIndex = source.indexOf("return;", snapshotWarningIndex);
  const snapshotSerializeIndex = source.indexOf("serializeAddonRef.current.serialize", snapshotReturnIndex);
  assert.ok(snapshotWarningIndex >= 0 && snapshotWarningIndex < snapshotReturnIndex);
  assert.ok(snapshotReturnIndex < snapshotSerializeIndex);

  const applyHandlerIndex = source.indexOf("onTerminalSessionApplySnapshot");
  const applyDrainIndex = source.indexOf("flushPendingTerminalWritesBeforeHibernate(term)", applyHandlerIndex);
  const applyFailureIndex = source.indexOf("Terminal output did not settle before applying the snapshot", applyDrainIndex);
  const applyMetadataIndex = source.indexOf("setKittyKeyboardProtocolEnabled", applyHandlerIndex);
  const applyResetIndex = source.indexOf("term.reset()", applyHandlerIndex);
  assert.ok(applyHandlerIndex >= 0 && applyHandlerIndex < applyDrainIndex);
  assert.ok(applyDrainIndex < applyFailureIndex);
  assert.ok(applyFailureIndex < applyMetadataIndex, "failed drains must not mutate snapshot metadata");
  assert.ok(applyMetadataIndex < applyResetIndex);
  assert.match(
    source,
    /const flushed = await flushPendingTerminalWritesBeforeHibernate\(snapshotTerm\);\s*if \(!flushed\) \{\s*throw new Error\("Terminal output did not settle before closing the attached display"\);\s*\}/,
  );
});
