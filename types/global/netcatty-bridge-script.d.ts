/// <reference path="./netcatty-bridge-script.d.ts" />

export type ScriptRunStatus = 'running' | 'paused' | 'completed' | 'failed';

export type ScriptProgressMode = 'activity' | 'determinate';

export interface ScriptRunLogEntry {
  at: number;
  message: string;
}

export interface ScriptRun {
  runId: string;
  scriptId?: string;
  scriptLabel?: string;
  sessionId: string;
  status: ScriptRunStatus;
  startedAt: number;
  endedAt?: number;
  /** @deprecated Use activityLabel for UI; kept for backward compatibility */
  currentStep?: string;
  stepIndex?: number;
  /** Internal telemetry only; do not use for overlay percentage */
  totalSteps?: number;
  progressMode?: ScriptProgressMode;
  activityLabel?: string;
  progressLabel?: string;
  progressCurrent?: number;
  progressTotal?: number;
  elapsedMs?: number;
  waitingFor?: string;
  logs: ScriptRunLogEntry[];
  error?: string;
}

export interface ScriptScreenSnapshot {
  rows: number;
  cols: number;
  currentRow: number;
  lines: string[];
}

export interface ScriptDialogRequest {
  requestId: string;
  type: 'alert' | 'confirm' | 'prompt' | 'waitForTimeout';
  message: string;
  defaultValue?: string;
  pattern?: string;
  timeoutMs?: number;
}

export interface ScriptRunParams {
  scriptId?: string;
  scriptLabel?: string;
  content: string;
  sessionId?: string;
  sessionIds?: string[];
  mode?: 'sequential' | 'parallel';
  permissionMode?: 'observer' | 'confirm' | 'auto';
  /** Renderer-provided session state (worker SSH sessions are not in main-process map). */
  sessionMeta?: {
    connected?: boolean;
    hostname?: string;
    username?: string;
  };
}

export type ScriptRecordingStep =
  | { type: 'send'; value: string; sensitive?: boolean }
  | { type: 'waitFor'; value: string; timeoutMs?: number }
  | { type: 'waitForPrompt'; timeoutMs?: number }
  | { type: 'sleep'; value: number };

declare global {
  interface NetcattyBridge {
    scriptRun(params: ScriptRunParams): Promise<{ runId: string; runIds: string[] }>;
    scriptStop(runId: string): Promise<{ ok: boolean }>;
    scriptPause(runId: string): Promise<{ ok: boolean }>;
    scriptResume(runId: string): Promise<{ ok: boolean }>;
    scriptGetRuns(sessionId?: string): Promise<ScriptRun[]>;
    scriptDialogResponse(requestId: string, value?: unknown, cancelled?: boolean): Promise<{ ok: boolean }>;
    scriptScreenSnapshotResponse(requestId: string, snapshot: ScriptScreenSnapshot): Promise<{ ok: boolean }>;
    scriptRecordingStart(sessionId: string): Promise<{ ok: boolean }>;
    scriptRecordingStop(sessionId: string): Promise<{ steps: ScriptRecordingStep[]; code: string }>;
    scriptRecordingAppendStep(sessionId: string, step: ScriptRecordingStep): Promise<{ ok: boolean }>;
    onScriptRunsUpdated(cb: (payload: { runs: ScriptRun[] }) => void): () => void;
    onScriptDialogRequest(cb: (payload: ScriptDialogRequest) => void): () => void;
    onScriptScreenSnapshotRequest(cb: (payload: { requestId: string; sessionId: string }) => void): () => void;
    onScriptSessionInput(cb: (payload: { sessionId: string; data: string }) => void): () => void;
  }
}

export {};
