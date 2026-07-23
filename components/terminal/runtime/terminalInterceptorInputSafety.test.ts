import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const runtimeSource = readFileSync(new URL("./createXTermRuntime.ts", import.meta.url), "utf8");
const attachmentSource = readFileSync(new URL("./terminalSessionAttachment.ts", import.meta.url), "utf8");
const terminalSource = readFileSync(new URL("../../Terminal.tsx", import.meta.url), "utf8");
const terminalLayerSource = readFileSync(new URL("../../TerminalLayer.tsx", import.meta.url), "utf8");
const preloadSource = readFileSync(
  new URL("../../../electron/preload/api.cjs", import.meta.url),
  "utf8",
);
const scriptBridgeSource = readFileSync(
  new URL("../../../electron/bridges/scriptBridge.cjs", import.meta.url),
  "utf8",
);
const scriptCodegenSource = readFileSync(
  new URL("../../../electron/scripts/scriptCodegen.cjs", import.meta.url),
  "utf8",
);
const scriptDialogSource = readFileSync(
  new URL("../../scripts/ScriptDialogHost.tsx", import.meta.url),
  "utf8",
);

test("password-prompt input is classified before prompt state reset and cannot broadcast", () => {
  assert.match(
    attachmentSource,
    /typeof meta\?\.pluginPipelineSensitiveInput === "boolean"[\s\S]*?passwordPromptActiveRef\.current = meta\.pluginPipelineSensitiveInput/u,
  );
  assert.match(
    terminalSource,
    /typeof meta\?\.pluginPipelineSensitiveInput === "boolean"[\s\S]*?passwordPromptActiveRef\.current = meta\.pluginPipelineSensitiveInput[\s\S]*?sensitivePromptOutputTailRef\.current = "";[\s\S]*?return;[\s\S]*?else if \(isUntrustedTerminalInputPrompt/u,
  );
  assert.match(
    runtimeSource,
    /const sensitive = ctx\.passwordPromptActiveRef\?\.current === true;[\s\S]*?const willBroadcastInput = !sensitive &&/u,
  );
  assert.match(
    runtimeSource,
    /writeToSession\(id, outData, \{ sensitive \}\)/u,
  );
  assert.match(
    runtimeSource,
    /writeToSession\(id, nextData, \{ sensitive \}\)/u,
  );
  assert.match(
    runtimeSource,
    /const broadcastUserPasteData = \(data: string\) => \{[\s\S]*?passwordPromptActiveRef\?\.current !== true[\s\S]*?onBroadcastInputRef\.current/u,
  );
  assert.match(
    terminalSource,
    /const sensitive = passwordPromptActiveRef\.current;[\s\S]*?!sensitive && isBroadcastEnabledRef\.current[\s\S]*?writeToSession\(id, data, \{[\s\S]*?sensitive,/u,
  );
});

test("Ctrl+C clears renderer password-prompt classification before the next input", () => {
  assert.match(
    runtimeSource,
    /clearTerminalInputStateForInterrupt\(\{[\s\S]*?passwordPromptActiveRef\.current = false;[\s\S]*?interruptSession/u,
  );
});

test("confirmed sudo credentials and preload transport preserve the sensitive marker", () => {
  assert.match(
    attachmentSource,
    /writeToSession\(id, data, \{ automated: true, sensitive: true \}\)/u,
  );
  assert.match(preloadSource, /sensitive: options\?\.sensitive === true/u);
});

test("OSC 52 clipboard replies bypass plugin input interception as sensitive host data", () => {
  assert.match(
    runtimeSource,
    /writeToSession\(\s*sessionId,\s*`\\x1b\]52;\$\{target\};\$\{b64\}\\x07`,\s*\{ sensitive: true \},\s*\)/u,
  );
});

test("generated script credentials stay masked and preserve the sensitive marker", () => {
  assert.match(scriptCodegenSource, /dialog\.prompt\([\s\S]*?\{ sensitive: true \}\)/u);
  assert.match(scriptCodegenSource, /screen\.sendLine\([\s\S]*?\{ sensitive: true \}\)/u);
  assert.match(scriptBridgeSource, /options\.sensitive === true \? \{ sensitive: true \} : \{\}/u);
  assert.match(scriptDialogSource, /type=\{request\.sensitive \? 'password' : 'text'\}/u);
});

test("renderer flow control acknowledges host ingress rather than transformed display length", () => {
  assert.match(
    attachmentSource,
    /const pluginPipelineIngressBytes = Number\.isFinite\(meta\?\.pluginPipelineIngressBytes\)[\s\S]*?const ingressBytes = pluginPipelineIngressBytes[\s\S]*?\?\? filtered\.acceptedBytes/u,
  );
  assert.match(
    attachmentSource,
    /filtered\.accepted && !filtered\.data && pluginPipelineIngressBytes != null[\s\S]*?acknowledgeDroppedTerminalDisplayBytes\(ctx, pluginPipelineIngressBytes\)/u,
  );
  assert.match(
    attachmentSource,
    /!filtered\.accepted && pluginPipelineIngressBytes != null[\s\S]*?\? pluginPipelineIngressBytes[\s\S]*?: pluginPipelineIngressBytes != null[\s\S]*?\? 0[\s\S]*?: filtered\.droppedBytes/u,
  );
  assert.match(
    attachmentSource,
    /const displayBytes = data\.length;[\s\S]*?enqueueTerminalWrite\(term, displayBytes,[\s\S]*?dropBytes: ingressBytes/u,
  );
  assert.match(
    readFileSync(new URL("./createTerminalSessionStarters.ts", import.meta.url), "utf8"),
    /const pluginPipelineIngressBytes = Number\.isFinite\(meta\?\.pluginPipelineIngressBytes\)[\s\S]*?!chunk && pluginPipelineIngressBytes > 0[\s\S]*?acknowledgeDroppedTerminalDisplayBytes\(ctx, pluginPipelineIngressBytes\)[\s\S]*?writeSessionData\(ctx, term, chunk, pluginPipelineIngressBytes, meta\)/u,
  );
  assert.match(
    terminalSource,
    /beginHibernatedSessionListeners[\s\S]*?\(chunk, meta\) =>[\s\S]*?observeTerminalInputPrompt\(chunk, meta\)[\s\S]*?Number\.isFinite\(meta\?\.pluginPipelineIngressBytes\)[\s\S]*?ackTerminalSessionFlow\(terminalBackend, backendId, pluginPipelineIngressBytes\)/u,
  );
});

test("active and hibernated output share host-owned sensitive prompt classification", () => {
  assert.match(
    terminalSource,
    /const observeTerminalInputPrompt = useCallback[\s\S]*?typeof meta\?\.pluginPipelineSensitiveInput === "boolean"[\s\S]*?passwordPromptActiveRef\.current = meta\.pluginPipelineSensitiveInput[\s\S]*?sensitivePromptOutputTailRef\.current = "";[\s\S]*?return;[\s\S]*?isConfirmedTerminalShellPrompt[\s\S]*?passwordPromptActiveRef\.current = false/u,
  );
  assert.match(
    terminalSource,
    /beginHibernatedSessionListeners[\s\S]*?observeTerminalInputPrompt\(chunk, meta\)/u,
  );
  assert.match(
    terminalSource,
    /onTerminalOutput: \(chunk: string, meta\?: TerminalSessionDataMeta\) => \{\s*observeTerminalInputPrompt\(chunk, meta\)/u,
  );
});

test("ordinary broadcast skips targets that are waiting for sensitive input", () => {
  assert.match(
    terminalLayerSource,
    /if \(isTerminalSensitiveInputActive\(session\.id\)\) continue;[\s\S]*?writeToSession\(session\.id, data/u,
  );
});
