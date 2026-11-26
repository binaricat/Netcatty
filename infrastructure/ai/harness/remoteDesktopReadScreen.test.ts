import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelMessage } from 'ai';
import type { NetcattyBridge } from '../cattyAgent/executor';
import {
  createCattyToolsFromCatalog,
  withCattyToolContext,
} from './capabilityTools';
import { buildCattyToolApproval } from './cattyToolApproval';
import { drainPendingRemoteScreenImagesIntoMessages } from './turnDrivers/cattyTurnDriver';
import {
  registerRemoteDesktopSnapshotProvider,
  resetRemoteDesktopSnapshotRegistryForTests,
  setRemoteDesktopAiReadBlocked,
} from '../../remoteDesktop/remoteDesktopSnapshotRegistry';
import {
  preemptRemoteDesktopControl,
  registerRemoteDesktopController,
  resetRemoteDesktopControlRegistryForTests,
} from '../../remoteDesktop/remoteDesktopControlRegistry';
import {
  listRemoteDesktopAuditEntries,
  resetRemoteDesktopAuditLogForTests,
} from '../../remoteDesktop/remoteDesktopAuditLog';
import { handleRemoteDesktopScreenRead } from '../vaultAgentBridgeClient';

const emptyBridge = {} as unknown as NetcattyBridge;

describe('remote_desktop_read_screen capability tool & dual-path delivery', () => {
  beforeEach(() => {
    resetRemoteDesktopSnapshotRegistryForTests();
  });

  it('omits remote_desktop_read_screen when no VNC/RDP session is in scope (preserves SSH prompt cache)', () => {
    const { tools } = createCattyToolsFromCatalog(
      emptyBridge,
      {
        sessions: [{
          sessionId: 'ssh-1',
          hostId: 'host-ssh-1',
          hostname: 'prod.internal',
          label: 'prod',
          protocol: 'ssh',
          connected: true,
        }],
      },
      [],
      'confirm',
      undefined,
      'chat-1',
    );
    assert.equal('remote_desktop_read_screen' in tools, false);
  });

  it('returns lightweight metadata from execute() and native content file parts from toModelOutput (Anthropic/Google/Responses)', async () => {
    registerRemoteDesktopSnapshotProvider('rdp-1', () => ({
      base64Data: 'QUJDREVGRw==',
      mediaType: 'image/jpeg',
      width: 1280,
      height: 720,
      naturalWidth: 1920,
      naturalHeight: 1080,
      protocol: 'rdp',
      hostLabel: 'win-box',
      hostname: '10.0.0.5',
    }));

    const bundle = createCattyToolsFromCatalog(
      emptyBridge,
      {
        sessions: [{
          sessionId: 'rdp-1',
          hostId: 'host-rdp-1',
          hostname: '10.0.0.5',
          label: 'win-box',
          protocol: 'rdp',
          connected: true,
        }],
      },
      [],
      'confirm',
      undefined,
      'chat-1',
      undefined,
      undefined,
      {
        supportsMultimodalToolResult: true,
        modelVisionSupport: 'yes',
        activeModelId: 'claude-sonnet-4-20250514',
      },
    );

    assert.equal('remote_desktop_read_screen' in bundle.tools, true);
    const rdTool = bundle.tools.remote_desktop_read_screen as unknown as {
      execute: (input: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<unknown>;
      toModelOutput?: (opts: { toolCallId: string; input: unknown; output: unknown }) => Promise<{ type: string; value: unknown }> | { type: string; value: unknown };
    };
    const output = await withCattyToolContext(
      rdTool,
      bundle.toolsContext.remote_desktop_read_screen,
      'call-rd-1',
    ).execute({ quality: 'standard' }) as Record<string, unknown>;

    assert.equal(output.ok, true);
    assert.equal(typeof output.captureId, 'string');
    assert.equal(output.sessionId, 'rdp-1');
    assert.equal('base64Data' in output, false, 'execute() must never leak base64 into chat history');

    assert.equal(typeof rdTool.toModelOutput, 'function');
    const modelOutput = await rdTool.toModelOutput!({
      toolCallId: 'call-rd-1',
      input: { quality: 'standard' },
      output,
    });

    assert.equal(modelOutput.type, 'content');
    if (modelOutput.type === 'content') {
      const value = modelOutput.value as Array<Record<string, unknown>>;
      assert.equal(value.length, 2);
      assert.equal(value[0].type, 'text');
      assert.deepEqual(value[1], {
        type: 'file',
        mediaType: 'image/jpeg',
        data: { type: 'data', data: 'QUJDREVGRw==' },
        filename: 'remote-screen.jpg',
      });
    }
    assert.equal(bundle.pendingScreenImages.length, 0);
  });

  it('uses OpenAI Chat Completions fallback queue + prepareStep synthetic user message bridge', async () => {
    registerRemoteDesktopSnapshotProvider('vnc-1', (opts) => ({
      base64Data: 'UE5HREFUQQ==',
      mediaType: 'image/png',
      width: 480,
      height: 210,
      naturalWidth: 1920,
      naturalHeight: 1080,
      crop: opts?.crop,
      protocol: 'vnc',
      hostLabel: 'ubuntu-desktop',
      hostname: '10.0.0.9',
    }));

    const bundle = createCattyToolsFromCatalog(
      emptyBridge,
      {
        sessions: [{
          sessionId: 'vnc-1',
          hostId: 'host-vnc-1',
          hostname: '10.0.0.9',
          label: 'ubuntu-desktop',
          protocol: 'vnc',
          connected: true,
        }],
      },
      [],
      'confirm',
      undefined,
      'chat-2',
      undefined,
      undefined,
      {
        supportsMultimodalToolResult: false,
        modelVisionSupport: 'yes',
        activeModelId: 'gpt-4o',
      },
    );

    const rdTool = bundle.tools.remote_desktop_read_screen as unknown as {
      execute: (input: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<unknown>;
      toModelOutput?: (opts: { toolCallId: string; input: unknown; output: unknown }) => Promise<{ type: string; value: unknown }> | { type: string; value: unknown };
    };
    const output = await withCattyToolContext(
      rdTool,
      bundle.toolsContext.remote_desktop_read_screen,
      'call-rd-2',
    ).execute({
      quality: 'high',
      cropX: 200,
      cropY: 300,
      cropWidth: 250,
      cropHeight: 200,
    }) as Record<string, unknown>;

    assert.equal(output.ok, true);
    const modelOutput = await rdTool.toModelOutput!({
      toolCallId: 'call-rd-2',
      input: { quality: 'high', cropX: 200, cropY: 300, cropWidth: 250, cropHeight: 200 },
      output,
    });

    assert.equal(modelOutput.type, 'text');
    if (modelOutput.type === 'text') {
      assert.match(String(modelOutput.value), /Chat Completions compatibility/);
      assert.doesNotMatch(String(modelOutput.value), /UE5HREFUQQ==/);
    }
    assert.equal(bundle.pendingScreenImages.length, 1);

    const baseMessages: ModelMessage[] = [{ role: 'user', content: 'Read the popup' }];
    const drained = drainPendingRemoteScreenImagesIntoMessages(baseMessages, bundle.pendingScreenImages);
    assert.equal(drained.didInject, true);
    assert.equal(bundle.pendingScreenImages.length, 0);
    assert.equal(drained.messages.length, 2);
    const synthetic = drained.messages[1];
    assert.equal(synthetic.role, 'user');
    assert.ok(Array.isArray(synthetic.content));
    const parts = synthetic.content as unknown as Array<Record<string, unknown>>;
    assert.match(String(parts[0].text), /\[Captured remote desktop frame:.*sessionId=vnc-1.*crop=200,300,250x200/);
    assert.deepEqual(parts[1], {
      type: 'file',
      data: 'UE5HREFUQQ==',
      mediaType: 'image/png',
      filename: 'remote-screen.png',
    });
  });

  it('respects privacy lock and known text-only model guard gracefully', async () => {
    registerRemoteDesktopSnapshotProvider('rdp-1', () => ({
      base64Data: 'QUJD',
      mediaType: 'image/jpeg',
      width: 1280,
      height: 720,
      naturalWidth: 1280,
      naturalHeight: 720,
      protocol: 'rdp',
    }));

    // Text-only model returns clean structured guidance instead of doomed 400
    const textOnlyBundle = createCattyToolsFromCatalog(
      emptyBridge,
      {
        sessions: [{
          sessionId: 'rdp-1',
          hostId: 'host-rdp-1',
          hostname: '10.0.0.5',
          label: 'win-box',
          protocol: 'rdp',
          connected: true,
        }],
      },
      [],
      'confirm',
      undefined,
      'chat-3',
      undefined,
      undefined,
      {
        supportsMultimodalToolResult: false,
        modelVisionSupport: 'no',
        activeModelId: 'deepseek-reasoner',
      },
    );
    const textOnlyTool = textOnlyBundle.tools.remote_desktop_read_screen as unknown as {
      execute: (input: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<unknown>;
    };
    const textOnlyRes = await withCattyToolContext(
      textOnlyTool,
      textOnlyBundle.toolsContext.remote_desktop_read_screen,
      'call-text-only',
    ).execute({}) as Record<string, unknown>;
    assert.equal(textOnlyRes.ok, false);
    assert.equal(textOnlyRes.code, 'VISION_UNSUPPORTED');
    assert.match(String(textOnlyRes.error), /deepseek-reasoner/);

    // Privacy lock blocks AI tool and vaultAgentBridgeClient MCP read
    setRemoteDesktopAiReadBlocked('rdp-1', true);
    const mcpBlocked = await handleRemoteDesktopScreenRead({ sessionId: 'rdp-1' });
    assert.equal(mcpBlocked.ok, false);
    assert.equal(mcpBlocked.code, 'PRIVACY_BLOCKED');

    // Unlocking restores vaultAgentBridgeClient MCP read with base64Data for native MCP image block
    setRemoteDesktopAiReadBlocked('rdp-1', false);
    const mcpOk = await handleRemoteDesktopScreenRead({ sessionId: 'rdp-1', quality: 'standard' });
    assert.equal(mcpOk.ok, true);
    assert.equal(mcpOk.base64Data, 'QUJD');
  });
});

describe('remote_desktop_act, grid overlay, approval gating, preemption & audit logging', () => {
  beforeEach(() => {
    resetRemoteDesktopSnapshotRegistryForTests();
    resetRemoteDesktopControlRegistryForTests();
    resetRemoteDesktopAuditLogForTests();
  });

  it('omits remote_desktop_act when only SSH sessions are in scope', () => {
    const { tools } = createCattyToolsFromCatalog(
      emptyBridge,
      {
        sessions: [{
          sessionId: 'ssh-1',
          hostId: 'host-ssh-1',
          hostname: 'prod.internal',
          label: 'prod',
          protocol: 'ssh',
          connected: true,
        }],
      },
      [],
      'confirm',
      undefined,
      'chat-ssh',
    );
    assert.equal('remote_desktop_read_screen' in tools, false);
    assert.equal('remote_desktop_act' in tools, false);
  });

  it('forwards grid="true" through remote_desktop_read_screen and attaches post-action screenshot for remote_desktop_act', async () => {
    const gridFlags: Array<boolean | undefined> = [];
    registerRemoteDesktopSnapshotProvider('rdp-act-1', (opts) => {
      gridFlags.push(opts?.grid);
      return {
        base64Data: 'QUJDREVGRw==',
        mediaType: 'image/jpeg',
        width: 1280,
        height: 720,
        naturalWidth: 1920,
        naturalHeight: 1080,
        grid: opts?.grid,
        protocol: 'rdp',
        hostLabel: 'win-app',
        hostname: '10.0.1.5',
      };
    });

    const performedTypes: string[] = [];
    registerRemoteDesktopController('rdp-act-1', {
      performAction: async (action) => {
        performedTypes.push(action.type);
      },
      releaseAllInputs: () => {},
      getState: () => ({
        connected: true,
        viewOnly: false,
        protocol: 'rdp',
        hostLabel: 'win-app',
        hostname: '10.0.1.5',
        desktopWidth: 1920,
        desktopHeight: 1080,
      }),
    });

    const bundle = createCattyToolsFromCatalog(
      emptyBridge,
      {
        sessions: [{
          sessionId: 'rdp-act-1',
          hostId: 'host-rdp-act-1',
          hostname: '10.0.1.5',
          label: 'win-app',
          protocol: 'rdp',
          connected: true,
        }],
      },
      [],
      'confirm',
      undefined,
      'chat-act-1',
      undefined,
      undefined,
      {
        supportsMultimodalToolResult: true,
        modelVisionSupport: 'yes',
        activeModelId: 'claude-sonnet-4-20250514',
      },
    );

    assert.equal('remote_desktop_act' in bundle.tools, true);

    // 1. Verify grid="true" on read_screen
    const readTool = bundle.tools.remote_desktop_read_screen as unknown as {
      execute: (input: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<unknown>;
    };
    const readOut = await withCattyToolContext(
      readTool,
      bundle.toolsContext.remote_desktop_read_screen,
      'call-grid-1',
    ).execute({ grid: 'true' }) as Record<string, unknown>;
    assert.equal(readOut.ok, true);
    assert.equal(readOut.grid, true);
    assert.equal(gridFlags[0], true);

    // 2. Verify remote_desktop_act executes actions, captures post-action screenshot, logs audit, and formats multimodal model output
    const actTool = bundle.tools.remote_desktop_act as unknown as {
      execute: (input: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<unknown>;
      toModelOutput?: (opts: { toolCallId: string; input: unknown; output: unknown }) => Promise<{ type: string; value: unknown }> | { type: string; value: unknown };
    };
    const actOut = await withCattyToolContext(
      actTool,
      bundle.toolsContext.remote_desktop_act,
      'call-act-1',
    ).execute({
      actions: JSON.stringify([
        { type: 'click', x: 480, y: 612 },
        { type: 'type', text: 'ipconfig' },
        { type: 'key', key: 'Enter' },
      ]),
      settleMs: 0,
      grid: 'true',
    }) as Record<string, unknown>;

    assert.equal(actOut.ok, true);
    assert.equal(actOut.completedActions, 3);
    assert.equal(typeof actOut.captureId, 'string');
    assert.equal(actOut.grid, true);
    assert.equal('base64Data' in actOut, false);
    assert.deepEqual(performedTypes, ['click', 'type', 'key']);
    assert.equal(gridFlags[1], true);

    const modelOut = await actTool.toModelOutput!({
      toolCallId: 'call-act-1',
      input: {},
      output: actOut,
    });
    assert.equal(modelOut.type, 'content');
    if (modelOut.type === 'content') {
      const parts = modelOut.value as Array<Record<string, unknown>>;
      assert.equal(parts.length, 2);
      assert.equal(parts[1].type, 'file');
      assert.equal(parts[1].mediaType, 'image/jpeg');
    }

    const audit = listRemoteDesktopAuditEntries('rdp-act-1');
    assert.equal(audit.length, 1);
    assert.equal(audit[0].outcome, 'ok');
    assert.equal(audit[0].completedActions, 3);
    assert.match(audit[0].summary, /Click \(480, 612\)/);
  });

  it('enforces scope gating, privacy lock, view-only lock, and user preemption with audit entries', async () => {
    let viewOnly = false;
    registerRemoteDesktopController('vnc-guard', {
      performAction: async (action) => {
        if (action.type === 'click') {
          preemptRemoteDesktopControl('vnc-guard', 'pointer');
        }
      },
      releaseAllInputs: () => {},
      getState: () => ({
        connected: true,
        viewOnly,
        protocol: 'vnc',
        hostLabel: 'ubuntu-gui',
        hostname: '10.0.2.8',
        desktopWidth: 1280,
        desktopHeight: 720,
      }),
    });

    const bundle = createCattyToolsFromCatalog(
      emptyBridge,
      {
        sessions: [
          {
            sessionId: 'vnc-guard',
            hostId: 'host-vnc-guard',
            hostname: '10.0.2.8',
            label: 'ubuntu-gui',
            protocol: 'vnc',
            connected: true,
          },
          {
            sessionId: 'ssh-other',
            hostId: 'host-ssh-other',
            hostname: '10.0.2.9',
            label: 'ssh-box',
            protocol: 'ssh',
            connected: true,
          },
        ],
      },
      [],
      'auto',
      undefined,
      'chat-guard',
    );

    const actTool = withCattyToolContext(
      bundle.tools.remote_desktop_act as unknown as {
        execute: (input: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<unknown>;
      },
      bundle.toolsContext.remote_desktop_act,
      'call-guard',
    );

    // Out-of-scope session rejected
    const outOfScope = await actTool.execute({
      sessionId: 'unknown-session',
      actions: JSON.stringify([{ type: 'wait', ms: 50 }]),
    }) as Record<string, unknown>;
    assert.equal(outOfScope.ok, false);
    assert.equal(outOfScope.code, 'OUT_OF_SCOPE');

    // Non-remote-desktop (SSH) session rejected
    const wrongProto = await actTool.execute({
      sessionId: 'ssh-other',
      actions: JSON.stringify([{ type: 'wait', ms: 50 }]),
    }) as Record<string, unknown>;
    assert.equal(wrongProto.ok, false);
    assert.equal(wrongProto.code, 'UNSUPPORTED_PROTOCOL');

    // Privacy lock blocks act
    setRemoteDesktopAiReadBlocked('vnc-guard', true);
    const privacyBlocked = await actTool.execute({
      actions: JSON.stringify([{ type: 'click', x: 100, y: 100 }]),
      captureAfter: 'false',
    }) as Record<string, unknown>;
    assert.equal(privacyBlocked.ok, false);
    assert.equal(privacyBlocked.code, 'AI_READ_BLOCKED');
    setRemoteDesktopAiReadBlocked('vnc-guard', false);

    // View-only blocks act
    viewOnly = true;
    const roBlocked = await actTool.execute({
      actions: JSON.stringify([{ type: 'click', x: 100, y: 100 }]),
      captureAfter: 'false',
    }) as Record<string, unknown>;
    assert.equal(roBlocked.ok, false);
    assert.equal(roBlocked.code, 'SESSION_VIEW_ONLY');
    viewOnly = false;

    // Preemption during action batch halts and logs preempted audit entry
    const preempted = await actTool.execute({
      actions: JSON.stringify([
        { type: 'click', x: 100, y: 100 },
        { type: 'type', text: 'never' },
      ]),
      captureAfter: 'false',
    }) as Record<string, unknown>;
    assert.equal(preempted.ok, false);
    assert.equal(preempted.code, 'USER_PREEMPTED');
    assert.equal(preempted.completedActions, 0);

    const audit = listRemoteDesktopAuditEntries('vnc-guard');
    assert.equal(audit.length, 3);
    assert.equal(audit[0].outcome, 'preempted');
    assert.equal(audit[1].outcome, 'blocked');
    assert.equal(audit[2].outcome, 'blocked');
  });

  it('enforces approval rules for remote_desktop_act across observer, confirm, and auto modes (including high-risk OS chords)', async () => {
    type ApprovalFn = (opts: {
      toolCall: { toolCallId: string; toolName: string; input: unknown };
    }) => Promise<unknown>;

    // Observer mode always denies remote_desktop_act
    const observerApproval = buildCattyToolApproval({ permissionMode: 'observer', chatSessionId: 'chat-obs' }) as unknown as ApprovalFn;
    const observerRes = await observerApproval({
      toolCall: {
        toolCallId: 'call-obs',
        toolName: 'remote_desktop_act',
        input: { actions: JSON.stringify([{ type: 'click', x: 10, y: 10 }]) },
      },
    });
    assert.deepEqual(observerRes, {
      type: 'denied',
      reason: 'Observer mode blocks write operations.',
    });

    // Auto mode auto-approves normal clicks/typing
    let autoPrompts = 0;
    const autoApproval = buildCattyToolApproval({
      permissionMode: 'auto',
      chatSessionId: 'chat-auto',
      requestApproval: async () => {
        autoPrompts += 1;
        return true;
      },
    }) as unknown as ApprovalFn;
    const autoNormal = await autoApproval({
      toolCall: {
        toolCallId: 'call-auto-normal',
        toolName: 'remote_desktop_act',
        input: { actions: JSON.stringify([{ type: 'click', x: 500, y: 500 }, { type: 'key', key: 'Enter' }]) },
      },
    });
    assert.equal(autoNormal, undefined);
    assert.equal(autoPrompts, 0);

    // Auto mode STILL requires fresh confirmation for high-risk OS chords like Ctrl+Alt+Del / Alt+F4 / Win+R
    const requestedCapIds: Array<string | undefined> = [];
    const autoHighRiskApproval = buildCattyToolApproval({
      permissionMode: 'auto',
      chatSessionId: 'chat-auto',
      requestApproval: async (_id, _name, _args, _chat, _timeout, capId) => {
        requestedCapIds.push(capId);
        return false;
      },
    }) as unknown as ApprovalFn;
    const highRiskDenied = await autoHighRiskApproval({
      toolCall: {
        toolCallId: 'call-auto-high-risk',
        toolName: 'remote_desktop_act',
        input: { actions: JSON.stringify([{ type: 'key', key: 'Alt+F4' }]) },
      },
    });
    assert.deepEqual(highRiskDenied, {
      type: 'denied',
      reason: 'User denied tool execution.',
    });
    assert.deepEqual(requestedCapIds, ['harness.remote_desktop.act:high-risk']);

    // Confirm mode prompts for normal actions
    let confirmPrompted = false;
    const confirmApproval = buildCattyToolApproval({
      permissionMode: 'confirm',
      chatSessionId: 'chat-confirm',
      requestApproval: async () => {
        confirmPrompted = true;
        return true;
      },
    }) as unknown as ApprovalFn;
    const confirmOk = await confirmApproval({
      toolCall: {
        toolCallId: 'call-confirm-1',
        toolName: 'remote_desktop_act',
        input: { actions: JSON.stringify([{ type: 'click', x: 200, y: 300 }]) },
      },
    });
    assert.equal(confirmPrompted, true);
    assert.deepEqual(confirmOk, { type: 'approved' });
  });
});
