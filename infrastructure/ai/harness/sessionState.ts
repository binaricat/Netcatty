import type { ChatMessage } from '../types';
import { redactSecretsForModel } from './modelSecretRedaction';

const MAX_DECISIONS = 15;
const MAX_BLOCKERS = 10;

const DECISION_PATTERNS = [
  /\bdecided to\b[:\s]+(.{10,200})/i,
  /\bwill use\b[:\s]+(.{10,200})/i,
  /\bconstraint[:\s]+(.{10,200})/i,
];

export interface ActiveTerminalJobState {
  sessionId?: string;
  command?: string;
  status: string;
  nextOffset: number;
  /**
   * Chat session id that owns this job in the main process. The main process
   * gates background-job control (`terminal.poll` / `terminal.stop`) on the
   * chat session id that started the job, so a branched chat that inherited
   * this job must dispatch its control calls under the owner's identity.
   * Set (and preserved through chained branches) by `copyState`.
   */
  ownerChatSessionId?: string;
}

export interface TerminalReadCursorState {
  range: string;
  startLine?: number;
  endLine?: number;
}

export interface CattySessionState {
  version: 1;
  userGoal?: string;
  decisions: string[];
  activeHosts: Record<string, { hostname?: string; lastCommand?: string }>;
  activeJobs: Record<string, ActiveTerminalJobState>;
  terminalReadCursors: Record<string, TerminalReadCursorState>;
  editedFiles: string[];
  planItems: Array<{ text: string; completed: boolean }>;
  blockers: string[];
  updatedAt: number;
}

function emptyState(): CattySessionState {
  return {
    version: 1,
    decisions: [],
    activeHosts: {},
    activeJobs: {},
    terminalReadCursors: {},
    editedFiles: [],
    planItems: [],
    blockers: [],
    updatedAt: Date.now(),
  };
}

function pushUnique(list: string[], value: string, cap: number): string[] {
  const trimmed = value.trim();
  if (!trimmed || list.includes(trimmed)) return list;
  return [...list, trimmed].slice(-cap);
}

function parseResultObject(resultText: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(resultText);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function terminalJobDefinitelyGone(result: Record<string, unknown> | undefined, resultText: string): boolean {
  const status = typeof result?.status === 'string' ? result.status.toLowerCase() : '';
  if (['completed', 'failed', 'stopped', 'exited', 'cancelled', 'canceled', 'not_found'].includes(status)) return true;
  const error = typeof result?.error === 'string' ? result.error : resultText;
  return /\b(?:job|task)\b.{0,40}\b(?:not found|does not exist|no longer exists|already (?:finished|completed|exited|stopped))\b/i.test(error)
    || /\b(?:unknown|no such)\s+(?:job|task)\b/i.test(error);
}

export class SessionStateStore {
  private readonly bySession = new Map<string, CattySessionState>();

  get(chatSessionId: string): CattySessionState {
    return this.bySession.get(chatSessionId) ?? emptyState();
  }

  clear(chatSessionId: string): void {
    this.bySession.delete(chatSessionId);
  }

  /**
   * Deep-copy the operational runtime state tracked under `fromChatSessionId`
   * into `toChatSessionId`. Used when a chat is branched (undo last turn): tool
   * side effects are not rolled back, so the branch must keep reinjecting the
   * operational state (active background jobs, poll offsets, edited files, ...)
   * that the undone turn set up. The two copies stay independent.
   *
   * Only operational side-effect state is copied here. Conversational state
   * (user goal, decisions, plan, blockers) is derived from messages, so the
   * branch rebuilds it from its retained prefix via
   * `rebuildConversationalStateFromMessages` instead: a full-state copy would
   * reinject plan updates, blockers, or decisions that the removed turn
   * produced even though the messages describing them are gone. Terminal read
   * cursors are likewise conversational bookkeeping (they record which
   * `terminal.read_context` tool results are still present in history), so they
   * are omitted from the copy: a cursor left behind by the undone turn would
   * make the branch believe it has read terminal output whose tool result was
   * removed. Omitting it is safe — the agent rereads instead of skipping
   * unseen output.
   */
  copyState(fromChatSessionId: string, toChatSessionId: string): void {
    if (fromChatSessionId === toChatSessionId) return;
    const state = this.bySession.get(fromChatSessionId);
    if (!state) return;
    this.bySession.set(toChatSessionId, {
      ...emptyState(),
      activeHosts: Object.fromEntries(
        Object.entries(state.activeHosts).map(([id, host]) => [id, { ...host }]),
      ),
      activeJobs: Object.fromEntries(
        Object.entries(state.activeJobs).map(([id, job]) => [
          id,
          {
            ...job,
            // Keep the original owner when copying an already-inherited job:
            // the main process still owns it under the chain's starting chat id,
            // so branch-of-branch copies must resolve to that same identity.
            ownerChatSessionId: job.ownerChatSessionId ?? fromChatSessionId,
          },
        ]),
      ),
      editedFiles: [...state.editedFiles],
      updatedAt: Date.now(),
    });
  }

  /**
   * Chat session id that owns `jobId` in the main process, when `jobId` was
   * inherited by `chatSessionId` from a branched source chat. Background-job
   * control calls (`terminal.poll` / `terminal.stop`) must present the owner's
   * chat session id to the main process, which rejects calls carrying the
   * branch's own id with "Background job not found". Returns undefined when
   * the job is not tracked under `chatSessionId` or is not inherited.
   */
  getInheritedJobOwnerChatSessionId(chatSessionId: string, jobId: string): string | undefined {
    const job = this.get(chatSessionId).activeJobs[jobId];
    return job?.ownerChatSessionId && job.ownerChatSessionId !== chatSessionId
      ? job.ownerChatSessionId
      : undefined;
  }

  /**
   * Rebuild the conversational state (user goal, decisions, blockers, plan) of
   * a branched chat by replaying its retained conversation prefix. The removed
   * turn's messages are gone, so conversational state captured while it ran
   * must not be reinjected into the branch (`toReinjectionText` would keep
   * steering the agent toward work the user just undid); replaying only the
   * retained messages restores exactly the state that history still refers to.
   */
  rebuildConversationalStateFromMessages(
    chatSessionId: string,
    messages: readonly ChatMessage[],
  ): void {
    const toolNames = new Map<string, string>();
    for (const message of messages) {
      for (const call of message.toolCalls ?? []) {
        if (call.name) toolNames.set(call.id, call.name);
      }
    }

    let userGoal: string | undefined;
    let decisions: string[] = [];
    let blockers: string[] = [];
    let planItems: Array<{ text: string; completed: boolean }> = [];
    for (const message of messages) {
      if (message.role === 'user' && message.content.trim()) {
        userGoal = message.content.trim().slice(0, 500);
      }
      if (message.role === 'assistant' && message.content) {
        for (const pattern of DECISION_PATTERNS) {
          const match = message.content.match(pattern);
          if (match?.[1]) {
            decisions = pushUnique(decisions, match[1].trim(), MAX_DECISIONS);
          }
        }
      }
      for (const result of message.toolResults ?? []) {
        if (!result.isError) continue;
        const toolName = result.toolName ?? toolNames.get(result.toolCallId) ?? 'unknown';
        const preview = result.content.slice(0, 160).replace(/\s+/g, ' ').trim();
        if (preview) blockers = pushUnique(blockers, `${toolName}: ${preview}`, MAX_BLOCKERS);
      }
      for (const activity of message.agentActivities ?? []) {
        if (activity.type === 'plan_update' && Array.isArray(activity.items)) {
          planItems = activity.items.map(item => ({ text: item.text, completed: item.completed }));
        }
      }
    }

    const state = { ...this.get(chatSessionId) };
    if (userGoal) state.userGoal = userGoal;
    state.decisions = decisions;
    state.blockers = blockers;
    state.planItems = planItems.slice(-30).map(item => ({
      text: item.text.slice(0, 300),
      completed: item.completed,
    }));
    state.updatedAt = Date.now();
    this.bySession.set(chatSessionId, state);
  }

  mergeFromUserGoal(chatSessionId: string, goal: string | undefined): void {
    if (!goal?.trim()) return;
    const state = { ...this.get(chatSessionId) };
    state.userGoal = goal.trim().slice(0, 500);
    state.updatedAt = Date.now();
    this.bySession.set(chatSessionId, state);
  }

  mergeFromAssistantContent(chatSessionId: string, content: string): void {
    let state = this.get(chatSessionId);
    for (const pattern of DECISION_PATTERNS) {
      const match = content.match(pattern);
      if (match?.[1]) {
        state = {
          ...state,
          decisions: pushUnique(state.decisions, match[1].trim(), MAX_DECISIONS),
          updatedAt: Date.now(),
        };
      }
    }
    this.bySession.set(chatSessionId, state);
  }

  mergeFileChanges(chatSessionId: string, paths: string[]): void {
    const state = { ...this.get(chatSessionId) };
    state.editedFiles = paths.reduce(
      (files, path) => pushUnique(files, path, 50),
      state.editedFiles,
    );
    state.updatedAt = Date.now();
    this.bySession.set(chatSessionId, state);
  }

  mergePlan(chatSessionId: string, items: Array<{ text: string; completed: boolean }>): void {
    const state = { ...this.get(chatSessionId) };
    state.planItems = items.slice(-30).map(item => ({
      text: item.text.slice(0, 300),
      completed: item.completed,
    }));
    state.updatedAt = Date.now();
    this.bySession.set(chatSessionId, state);
  }

  updateFromToolResult(
    chatSessionId: string,
    toolName: string,
    args: Record<string, unknown> | undefined,
    resultText: string,
    isError?: boolean,
  ): void {
    const state = { ...this.get(chatSessionId) };
    const name = toolName.toLowerCase();
    const result = parseResultObject(resultText);

    if (name === 'terminal_execute' || name === 'terminal.execute') {
      const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : undefined;
      const command = typeof args?.command === 'string' ? args.command : undefined;
      if (sessionId) {
        state.activeHosts = {
          ...state.activeHosts,
          [sessionId]: {
            ...state.activeHosts[sessionId],
            lastCommand: command,
          },
        };
      }
    }

    if (name === 'terminal_start' || name === 'terminal.start') {
      const jobId = typeof result?.jobId === 'string' ? result.jobId : undefined;
      if (jobId && !isError) {
        state.activeJobs = {
          ...state.activeJobs,
          [jobId]: {
            sessionId: typeof args?.sessionId === 'string' ? args.sessionId : undefined,
            command: typeof args?.command === 'string' ? args.command : undefined,
            status: typeof result?.status === 'string' ? result.status : 'running',
            nextOffset: typeof result?.nextOffset === 'number' ? result.nextOffset : 0,
          },
        };
      }
    }

    if (name === 'terminal_poll' || name === 'terminal.poll') {
      const jobId = typeof args?.jobId === 'string'
        ? args.jobId
        : typeof result?.jobId === 'string' ? result.jobId : undefined;
      if (jobId && !isError) {
        const status = typeof result?.status === 'string' ? result.status : 'running';
        if (status === 'running' || status === 'stopping') {
          state.activeJobs = {
            ...state.activeJobs,
            [jobId]: {
              ...state.activeJobs[jobId],
              status,
              nextOffset: typeof result?.nextOffset === 'number'
                ? result.nextOffset
                : state.activeJobs[jobId]?.nextOffset ?? 0,
            },
          };
        } else if (state.activeJobs[jobId]) {
          state.activeJobs = { ...state.activeJobs };
          delete state.activeJobs[jobId];
        }
      } else if (jobId && state.activeJobs[jobId]) {
        if (terminalJobDefinitelyGone(result, resultText)) {
          state.activeJobs = { ...state.activeJobs };
          delete state.activeJobs[jobId];
        } else {
          state.activeJobs = {
            ...state.activeJobs,
            [jobId]: { ...state.activeJobs[jobId], status: 'unverified' },
          };
        }
      }
    }

    if (name === 'terminal_stop' || name === 'terminal.stop') {
      const jobId = typeof args?.jobId === 'string' ? args.jobId : undefined;
      if (jobId && state.activeJobs[jobId]) {
        state.activeJobs = {
          ...state.activeJobs,
          [jobId]: { ...state.activeJobs[jobId], status: 'stopping' },
        };
      }
    }

    if (name === 'terminal_read_context' || name === 'terminal.read_context') {
      const sessionId = typeof args?.sessionId === 'string'
        ? args.sessionId
        : typeof result?.sessionId === 'string' ? result.sessionId : undefined;
      if (sessionId && !isError) {
        state.terminalReadCursors = {
          ...state.terminalReadCursors,
          [sessionId]: {
            range: typeof args?.range === 'string' ? args.range : 'viewport',
            startLine: typeof result?.startLine === 'number'
              ? result.startLine
              : typeof args?.startLine === 'number' ? args.startLine : undefined,
            endLine: typeof result?.endLine === 'number' ? result.endLine : undefined,
          },
        };
      }
    }

    if ((name === 'session_close' || name === 'session.close') && !isError) {
      const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : undefined;
      if (sessionId) {
        state.activeHosts = { ...state.activeHosts };
        state.terminalReadCursors = { ...state.terminalReadCursors };
        delete state.activeHosts[sessionId];
        delete state.terminalReadCursors[sessionId];
        state.activeJobs = Object.fromEntries(
          Object.entries(state.activeJobs).filter(([, job]) => job.sessionId !== sessionId),
        );
      }
    }

    if (isError) {
      const preview = resultText.slice(0, 160).replace(/\s+/g, ' ').trim();
      if (preview) {
        state.blockers = pushUnique(state.blockers, `${toolName}: ${preview}`, MAX_BLOCKERS);
      }
    }

    state.updatedAt = Date.now();
    this.bySession.set(chatSessionId, state);
  }

  toReinjectionText(chatSessionId: string): string | undefined {
    const state = this.get(chatSessionId);
    const lines: string[] = [];
    if (state.userGoal) lines.push(`User goal: ${state.userGoal}`);
    if (state.decisions.length) {
      lines.push(`Decisions: ${state.decisions.slice(-5).join('; ')}`);
    }
    const hosts = Object.entries(state.activeHosts);
    if (hosts.length) {
      const hostSummary = hosts
        .slice(-5)
        .map(([id, host]) => `${id}${host.lastCommand ? ` (last: ${redactSecretsForModel(host.lastCommand)})` : ''}`)
        .join(', ');
      lines.push(`Active hosts: ${hostSummary}`);
    }
    const jobs = Object.entries(state.activeJobs);
    if (jobs.length) {
      const jobSummary = jobs.slice(-5).map(([jobId, job]) => (
        `${jobId} (status=${job.status}, offset=${job.nextOffset}${job.sessionId ? `, session=${job.sessionId}` : ''}${job.command ? `, command=${redactSecretsForModel(job.command)}` : ''})`
      )).join('; ');
      lines.push(`Remembered terminal jobs (status is unverified after compaction): ${jobSummary}. Poll the existing job from its saved offset to verify current status; do not restart its command.`);
    }
    const cursors = Object.entries(state.terminalReadCursors);
    if (cursors.length) {
      lines.push(`Terminal read cursors: ${cursors.slice(-5).map(([id, cursor]) => `${id} (${cursor.range}, lines=${cursor.startLine ?? '?'}-${cursor.endLine ?? '?'})`).join(', ')}`);
    }
    if (state.editedFiles.length) {
      lines.push(`Edited files: ${state.editedFiles.slice(-20).join(', ')}`);
    }
    if (state.planItems.length) {
      lines.push(`Plan: ${state.planItems.map(item => `${item.completed ? '[done]' : '[todo]'} ${item.text}`).join('; ')}`);
    }
    if (state.blockers.length) {
      lines.push(`Open blockers: ${state.blockers.slice(-3).join('; ')}`);
    }
    if (lines.length === 0) return undefined;
    return lines.join('\n');
  }
}

export const globalSessionStateStore = new SessionStateStore();
