import { LocalHarnessClient } from '../../sdk/antigravity/localharnessClient';
import type { TurnDriver, TurnInput, TurnDriverContext, TurnSteerInput, TurnSteerResult, AntigravityTurnInput, ExternalTurnContext, CattyTurnContext } from './types';
import { generateId, getNetcattyBridge } from '../../../../components/ai/hooks/aiChatStreamingSupport';
import { createCattyToolsFromCatalog } from '../capabilityTools';
import { isToolResultError } from '../../../../components/ai/hooks/aiChatStreamingSupport';
import type { ExecutorContext } from '../../cattyAgent/executor';

export class AntigravityTurnDriver implements TurnDriver {
  readonly backend = 'antigravity' as const;
  private readonly liveTurns = new Map<string, LocalHarnessClient>();

  async run(input: TurnInput, ctx: TurnDriverContext): Promise<void> {
    if (input.backend !== 'antigravity') {
      throw new Error('AntigravityTurnDriver expects antigravity input');
    }

    const {
      chatSessionId: sessionId,
      assistantMsgId,
      userText: trimmed,
      signal,
      context,
      bridge,
      ui,
    } = input as AntigravityTurnInput;

    ui.setStreamingForScope(sessionId, true);

    const netcattyBridge = (bridge ?? getNetcattyBridge()) as NonNullable<ReturnType<typeof getNetcattyBridge>>;

    const getExecutorContext = context.getExecutorContext ?? (() => ({
      sessions: context.terminalSessions,
      workspaceId: context.scopeType === 'workspace' ? context.scopeTargetId : undefined,
      workspaceName: context.scopeType === 'workspace' ? context.scopeLabel : undefined,
    } as ExecutorContext));

    // Create our native tool bundle (same as what Vercel AI SDK gets)
    const toolsBundle = createCattyToolsFromCatalog(
      netcattyBridge,
      getExecutorContext,
      context.commandBlocklist,
      context.globalPermissionMode,
      context.webSearchConfig ?? undefined,
      sessionId,
      ctx.toolOutputStore,
      ctx.toolResultDedup,
    );

    const client = new LocalHarnessClient({
      binaryPath: input.agentConfig.customPath || '/tmp/agy-sdk/google/antigravity/bin/localharness',
      appDataDir: (globalThis as any).process?.env?.HOME 
        ? (globalThis as any).process.env.HOME + '/.gemini/antigravity-cli'
        : '/tmp/.gemini/antigravity-cli',
      debug: false
    });

    this.liveTurns.set(sessionId, client);
    
    // TEMPORARY LOGGING HELPER
    const logToFile = (msg: string) => {
      try {
        const fs = require('fs');
        fs.appendFileSync('/tmp/netcatty-harness.log', `[${new Date().toISOString()}] ${msg}\n`);
      } catch (e) {}
    };
    logToFile(`--- Starting Antigravity Turn for Session ${sessionId} ---`);

    try {
      await client.initialize(sessionId);
      logToFile("Client initialized via bridge");

      if (signal) {
        signal.addEventListener('abort', () => client.destroy(), { once: true });
      }

      const harnessTools = Object.entries(toolsBundle.tools).map(([name, tool]) => {
        // Zod to JSON Schema conversion (simplified for prototype)
        return {
          name,
          description: tool.description,
          parameters_json_schema: JSON.stringify({ type: "object" })
        };
      });

      const isExternalContext = !('activeProvider' in context);
      const activeProvider = isExternalContext
        ? (context as any as ExternalTurnContext).providers?.find(p => 
            p.providerId === 'google' || 
            p.id === 'google' || 
            p.style === 'google' ||
            (p.name && p.name.toLowerCase().includes('google'))
          )
        : (context as CattyTurnContext).activeProvider;
      
      let rawApiKey = activeProvider?.apiKey;
      if (rawApiKey && rawApiKey.startsWith('enc:v1:') && netcattyBridge.credentialsDecrypt) {
        try {
          rawApiKey = await netcattyBridge.credentialsDecrypt(rawApiKey);
        } catch (e) {
          console.error('Failed to decrypt API key', e);
        }
      }
      
      const activeModelId = (!isExternalContext && (context as CattyTurnContext).activeModelId) 
        || activeProvider?.defaultModel 
        || 'gemini-2.5-pro';
      const cascadeId = sessionId.replace(/_/g, '-').padEnd(32, '0');

      const payloadConfig = {
        config: {
          cascade_id: cascadeId,
          session_continuation_mode: 'CREATE_OR_RESUME',
          system_instructions: {
            custom: { part: [{ text: "You are Antigravity, integrated in Netcatty." }] }
          },
          models: [{
            name: activeModelId,
            types: ["MODEL_TYPE_TEXT"],
            ...(rawApiKey ? {
              gemini_api_endpoint: { api_key: rawApiKey }
            } : {
              vertex_endpoint: { project: client.adcProject || '', location: "us-central1" } // Fallback to Application Default Credentials (ADC)
            })
          }],
          tools: harnessTools
        }
      };
      logToFile(`Sending Config: ${JSON.stringify(payloadConfig)}`);
      client.sendJson(payloadConfig);

      let activeAssistantMsgId = assistantMsgId;
      let needsNewAssistantMsg = false;
      let buffer = '';
      
      const maybeCreateAssistantMsg = () => {
        if (!needsNewAssistantMsg) return;
        needsNewAssistantMsg = false;
        activeAssistantMsgId = generateId();
        ui.addMessageToSession(sessionId, {
          id: activeAssistantMsgId,
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          model: 'antigravity',
        });
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client.onClose = () => {
        ui.reportStreamError(sessionId, signal, new Error("Antigravity process terminated unexpectedly (e.g. invalid model name or crash)"));
        ui.setStreamingForScope(sessionId, false);
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client.onEvent = async (event: Record<string, any>) => {
        logToFile(`Received Event: ${JSON.stringify(event)}`);
        
        if (event.stepUpdate) {
          const step = event.stepUpdate;
          
          if (step.textDelta && step.source !== 'SOURCE_USER') {
            maybeCreateAssistantMsg();
            buffer += step.textDelta;
            ui.updateMessageById(sessionId, activeAssistantMsgId, (msg) => ({
              ...msg,
              content: buffer,
            }));
          }

          if (step.errorMessage) {
            ui.reportStreamError(sessionId, signal, step.errorMessage);
            client.destroy();
            return;
          }

          // Bidirectional Tool Conversion Handle
          if (step.toolCall) {
            maybeCreateAssistantMsg();
            const { id, name, argumentsJson: toolArgsStr } = step.toolCall;
            const toolCallId = id || `tc_${Date.now()}`;
            
            let parsedArgs = {};
            try {
              if (toolArgsStr) {
                parsedArgs = JSON.parse(toolArgsStr);
              }
            } catch {
              console.error("Failed to parse tool call args:", toolArgsStr);
            }

            // 1. Show the tool call in UI
            ui.updateMessageById(sessionId, activeAssistantMsgId, msg => ({
              ...msg,
              toolCalls: [...(msg.toolCalls || []), { id: toolCallId, name, arguments: parsedArgs }],
              executionStatus: 'running',
            }));

            let resultStr = "";
            let isError = false;
            let resultObj: any;
            try {
              const toolDefinition = toolsBundle.tools[name];
              if (!toolDefinition || typeof toolDefinition.execute !== 'function') {
                throw new Error(`Tool ${name} not found or not executable.`);
              }
              console.log(`[TurnDriver] Executing tool ${name}...`);
              resultObj = await toolDefinition.execute!(parsedArgs, {
                toolCallId,
                messages: [],
                abortSignal: signal,
                context: toolsBundle.toolsContext[name] as any
              });
              console.log(`[TurnDriver] Tool ${name} executed successfully.`);
              resultStr = typeof resultObj === 'string' ? resultObj : JSON.stringify(resultObj);
            } catch (err: unknown) {
              isError = true;
              const errorMsg = err instanceof Error ? err.message : String(err);
              resultObj = { error: errorMsg };
              resultStr = JSON.stringify(resultObj);
            }

            // 3. Mark tool call as completed in UI and add the Tool Result message
            ui.updateMessageById(sessionId, activeAssistantMsgId, msg => ({
              ...msg,
              executionStatus: 'completed'
            }));
            
            ui.addMessageToSession(sessionId, {
              id: generateId(),
              role: 'tool',
              content: '',
              toolResults: [{
                toolCallId,
                toolName: name,
                content: resultStr,
                isError: isError || isToolResultError(resultStr),
              }],
              timestamp: Date.now(),
              executionStatus: 'completed',
            });
            
            needsNewAssistantMsg = true;
            buffer = '';

            // 4. Send toolResponse back to localharness
            client.sendJson({
              toolResponse: {
                id: toolCallId,
                name: name,
                responseJson: resultStr
              }
            });
          }
        }

        if (event.trajectoryStateUpdate) {
          const state = event.trajectoryStateUpdate.state;
          if (state === 'STATE_DONE' || state === 'STATE_ERROR') {
            client.destroy();
            return;
          }
        }

        if (event.initializeConversationResponse) {
          logToFile(`Sending user input: ${trimmed}`);
          // Send the user input ONLY AFTER initialization is complete!
          client.sendJson({
            user_input: trimmed
          });
        }

        if (event.sessionEndResponse) {
          client.destroy();
        }
      };

      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (signal?.aborted || !this.liveTurns.has(sessionId) || !client.isOpen()) {
            clearInterval(check);
            resolve();
          }
        }, 100);
      });

    } catch (err) {
      logToFile(`Error caught: ${err}`);
      ui.reportStreamError(sessionId, signal, err);
    } finally {
      logToFile(`Finally cleaning up`);
      this.liveTurns.delete(sessionId);
      client.destroy();
      ui.setStreamingForScope(sessionId, false);
    }
  }

  async steer(_input: TurnSteerInput): Promise<TurnSteerResult> {
    return { status: 'unsupported' };
  }

  abort(chatSessionId: string): void {
    const client = this.liveTurns.get(chatSessionId);
    if (client) {
      client.destroy();
      this.liveTurns.delete(chatSessionId);
    }
  }
}

export const antigravityTurnDriver = new AntigravityTurnDriver();
