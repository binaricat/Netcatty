import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelMessage } from 'ai';
import type { NetcattyBridge } from '../cattyAgent/executor';
import {
  createCattyToolsFromCatalog,
  withCattyToolContext,
} from './capabilityTools';
import { drainPendingRemoteScreenImagesIntoMessages } from './turnDrivers/cattyTurnDriver';
import {
  registerRemoteDesktopSnapshotProvider,
  resetRemoteDesktopSnapshotRegistryForTests,
  setRemoteDesktopAiReadBlocked,
} from '../../remoteDesktop/remoteDesktopSnapshotRegistry';
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
