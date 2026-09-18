import { useCallback, useEffect, useRef, useState } from 'react';
import { netcattyBridge } from '@/infrastructure/services/netcattyBridge.ts';
import { DEFAULT_RECORDING_PROMPT_TIMEOUT_MS } from '@/domain/snippetScript.ts';
import type { ScriptRecordingStep } from '@/types/global/netcatty-bridge-script.d.ts';
import { notify } from '../notification';

export const MAX_PENDING_SCRIPT_RECORDING_INPUT_CHARS = 256 * 1024;
export const SCRIPT_RECORDING_LIMIT_EVENT = 'netcatty:script:recording:limit';

type ScriptRecordingLimitDetail = {
  sessionId: string;
  error: string;
  steps: ScriptRecordingStep[];
  code: string;
};

type ScriptRecordingResult = {
  steps: ScriptRecordingStep[];
  code: string;
};

const emptyScriptRecordingResult = (): ScriptRecordingResult => ({ steps: [], code: '' });

export function useScriptRecorder(sessionId: string | undefined) {
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const startedAtRef = useRef<number | null>(null);
  const inputBufferRef = useRef('');
  const lastStepAtRef = useRef<number>(Date.now());
  const isRecordingRef = useRef(false);
  const isPausedRef = useRef(false);
  const isStoppingRef = useRef(false);
  const stopPromiseRef = useRef<Promise<ScriptRecordingResult> | null>(null);
  const sessionIdRef = useRef(sessionId);
  const recordingGenerationRef = useRef(0);
  const pendingRecordStepsRef = useRef(Promise.resolve());
  const isDrainingRecordingRef = useRef(false);

  sessionIdRef.current = sessionId;

  useEffect(() => {
    if (!isRecording || isPaused) return undefined;
    const timer = window.setInterval(() => {
      if (startedAtRef.current) {
        setElapsedMs(Date.now() - startedAtRef.current);
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [isRecording, isPaused]);

  const startRecording = useCallback(async () => {
    const pendingStop = stopPromiseRef.current;
    if (pendingStop) {
      try {
        await pendingStop;
      } catch {
        // A failed stop still closes the local recording. Starting again is
        // the explicit recovery path and must happen after that stop settles.
      }
    }
    const sid = sessionIdRef.current;
    const bridge = netcattyBridge.get();
    if (!sid || !bridge?.scriptRecordingStart) return;
    await bridge.scriptRecordingStart(sid);
    recordingGenerationRef.current += 1;
    startedAtRef.current = Date.now();
    lastStepAtRef.current = Date.now();
    inputBufferRef.current = '';
    setElapsedMs(0);
    setIsPaused(false);
    isPausedRef.current = false;
    isStoppingRef.current = false;
    isRecordingRef.current = true;
    setIsRecording(true);
  }, []);

  const stopRecording = useCallback(async () => {
    if (stopPromiseRef.current) return stopPromiseRef.current;
    const sid = sessionIdRef.current;
    const bridge = netcattyBridge.get();
    isStoppingRef.current = true;
    isDrainingRecordingRef.current = true;
    isRecordingRef.current = false;
    isPausedRef.current = false;
    setIsRecording(false);
    setIsPaused(false);
    inputBufferRef.current = '';
    startedAtRef.current = null;
    if (!sid || !bridge?.scriptRecordingStop) {
      isStoppingRef.current = false;
      isDrainingRecordingRef.current = false;
      return emptyScriptRecordingResult();
    }
    const stopRequest = pendingRecordStepsRef.current.catch(() => {}).then(() => bridge.scriptRecordingStop!(sid));
    let stopPromise: Promise<ScriptRecordingResult>;
    stopPromise = stopRequest.finally(() => {
      if (stopPromiseRef.current === stopPromise) {
        stopPromiseRef.current = null;
        isStoppingRef.current = false;
        isDrainingRecordingRef.current = false;
      }
    });
    stopPromiseRef.current = stopPromise;
    return stopPromise;
  }, []);

  const finishAutomaticStop = useCallback((detail: ScriptRecordingLimitDetail) => {
    isDrainingRecordingRef.current = false;
    isRecordingRef.current = false;
    isPausedRef.current = false;
    inputBufferRef.current = '';
    startedAtRef.current = null;
    setIsRecording(false);
    setIsPaused(false);
    notify.error(detail.error, 'Scripts');
    window.dispatchEvent(new CustomEvent(SCRIPT_RECORDING_LIMIT_EVENT, { detail }));
  }, []);

  const pauseRecording = useCallback(() => {
    if (isStoppingRef.current) return;
    isPausedRef.current = true;
    setIsPaused(true);
  }, []);

  const resumeRecording = useCallback(() => {
    if (isStoppingRef.current) return;
    isPausedRef.current = false;
    setIsPaused(false);
  }, []);

  const appendStep = useCallback(async (step: ScriptRecordingStep, accepted = false) => {
    const sid = sessionIdRef.current;
    if (!sid || (!(accepted && isDrainingRecordingRef.current)
      && (!isRecordingRef.current || (!accepted && isPausedRef.current) || isStoppingRef.current))) return;
    const generation = recordingGenerationRef.current;
    const result = await netcattyBridge.get()?.scriptRecordingAppendStep?.(sid, step);
    if (generation !== recordingGenerationRef.current || sid !== sessionIdRef.current) return;
    if (result?.stopped) {
      finishAutomaticStop({
        sessionId: sid,
        error: result.error || 'Recording stopped because it reached the safety limit',
        steps: result.steps ?? [],
        code: result.code ?? '',
      });
      return;
    }
    lastStepAtRef.current = Date.now();
  }, [finishAutomaticStop]);

  const recordInput = useCallback((data: string) => {
    if (!isRecordingRef.current || isPausedRef.current || isStoppingRef.current) return;
    const next = `${inputBufferRef.current}${data}`;
    if (next.length <= MAX_PENDING_SCRIPT_RECORDING_INPUT_CHARS) {
      inputBufferRef.current = next;
      return;
    }
    const sid = sessionIdRef.current;
    if (!sid) return;
    isStoppingRef.current = true;
    isRecordingRef.current = false;
    isPausedRef.current = false;
    inputBufferRef.current = '';
    startedAtRef.current = null;
    setIsRecording(false);
    setIsPaused(false);
    const bridge = netcattyBridge.get();
    let stopRequest: Promise<ScriptRecordingResult>;
    try {
      stopRequest = bridge?.scriptRecordingStop
        ? Promise.resolve(bridge.scriptRecordingStop(sid))
        : Promise.resolve(emptyScriptRecordingResult());
    } catch (error) {
      stopRequest = Promise.reject(error);
    }
    const stopCompletion = stopRequest.catch(() => emptyScriptRecordingResult()).then((result) => {
      finishAutomaticStop({
        sessionId: sid,
        error: 'Recording stopped because the current input exceeded the safety limit',
        steps: result.steps,
        code: result.code,
      });
      return result;
    });
    let stopPromise: Promise<ScriptRecordingResult>;
    stopPromise = stopCompletion.finally(() => {
      if (stopPromiseRef.current === stopPromise) {
        stopPromiseRef.current = null;
        isStoppingRef.current = false;
      }
    });
    stopPromiseRef.current = stopPromise;
  }, [finishAutomaticStop]);

  const recordBackspace = useCallback(() => {
    if (!isRecordingRef.current || isPausedRef.current || isStoppingRef.current) return;
    inputBufferRef.current = inputBufferRef.current.slice(0, -1);
  }, []);

  const recordClearLine = useCallback(() => {
    if (!isRecordingRef.current || isPausedRef.current || isStoppingRef.current) return;
    inputBufferRef.current = '';
  }, []);

  const recordEnter = useCallback(async (options?: { sensitive?: boolean; submittedLine?: string }) => {
    const sid = sessionIdRef.current;
    if (!isRecordingRef.current || isPausedRef.current || isStoppingRef.current || !sid) return;
    const line = options?.submittedLine ?? inputBufferRef.current;
    if (options?.submittedLine === undefined) inputBufferRef.current = '';
    const now = Date.now();
    const gap = now - lastStepAtRef.current;
    lastStepAtRef.current = now;
    const generation = recordingGenerationRef.current;
    const pending = pendingRecordStepsRef.current.catch(() => {}).then(async () => {
      const isCurrent = () => generation === recordingGenerationRef.current && sid === sessionIdRef.current
        && (isRecordingRef.current || isDrainingRecordingRef.current);
      if (!isCurrent()) return;
      if (gap > 1000) await appendStep({ type: 'sleep', value: gap }, true);
      if (!isCurrent()) return;
      await appendStep({ type: 'send', value: line, sensitive: options?.sensitive }, true);
      if (!isCurrent()) return;
      await appendStep({ type: 'waitForPrompt', timeoutMs: DEFAULT_RECORDING_PROMPT_TIMEOUT_MS }, true);
    });
    pendingRecordStepsRef.current = pending;
    await pending;
  }, [appendStep]);

  // Delayed paste receipts must not consume newly typed input or leak into a
  // recording started after the paste. Each receipt records one actual write.
  const captureSubmittedLineRecorder = useCallback(() => {
    if (!isRecordingRef.current || isPausedRef.current || isStoppingRef.current) return undefined;
    const generation = recordingGenerationRef.current;
    const sid = sessionIdRef.current;
    const pendingInput = inputBufferRef.current;
    inputBufferRef.current = '';
    const isCurrent = () => generation === recordingGenerationRef.current
      && sid === sessionIdRef.current && isRecordingRef.current
      && !isPausedRef.current && !isStoppingRef.current;
    return (line: string, options?: { sensitive?: boolean; includePendingInput?: boolean }): Promise<void> => {
      if (!isCurrent()) return Promise.resolve();
      return recordEnter({ sensitive: options?.sensitive, submittedLine: options?.includePendingInput ? `${pendingInput}${line}` : line });
    };
  }, [recordEnter]);

  return {
    isRecording,
    isPaused,
    elapsedMs,
    startRecording,
    stopRecording,
    pauseRecording,
    resumeRecording,
    recordInput,
    recordBackspace,
    recordClearLine,
    recordEnter,
    captureSubmittedLineRecorder,
  };
}
