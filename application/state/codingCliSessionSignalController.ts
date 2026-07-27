import { useEffect, useRef } from 'react';
import { matchCodingCliProviderFromCommand } from '../../domain/codingCliProviderMatch';
import {
  createCodingCliOutputScanner,
  type CodingCliOutputScanner,
} from '../../domain/codingCliOutputDetect';
import type { CodingCliProviderId } from '../../domain/codingCliProviders';
import {
  inferCodingCliProviderFromTitleSignals,
  shouldClearCodingCliProviderForTitle,
} from '../../domain/codingCliTitleParse';
import type { DynamicTabTitleMode } from '../../domain/models';
import {
  resolveCodingCliProviderIconUpdate,
  shouldUpdateCodingCliTabIcon,
} from '../../domain/sessionTabTitle';

type CodingCliIconSession = {
  id: string;
  codingCliProviderId?: CodingCliProviderId;
};

export type CodingCliSessionSignalControllerDeps = {
  getDynamicTabTitleMode: () => DynamicTabTitleMode;
  getSession: (sessionId: string) => CodingCliIconSession | undefined;
  onUpdateSessionCodingCliProvider?: (
    sessionId: string,
    providerId: CodingCliProviderId | null,
  ) => void;
  onUpdateSessionDynamicTitle?: (sessionId: string, title: string | null) => void;
};

export type CodingCliSessionSignalController = {
  handleDynamicTabTitleModeChange: (mode: DynamicTabTitleMode) => void;
  handleCommandSubmitted: (sessionId: string, commandLine: string) => void;
  handleTerminalOutput: (sessionId: string, chunk: string) => void;
  handleTerminalTitleChange: (sessionId: string, title: string | null) => void;
  forgetSession: (sessionId: string) => void;
};

type UseCodingCliSessionSignalsOptions = Omit<
  CodingCliSessionSignalControllerDeps,
  'getDynamicTabTitleMode'
> & {
  dynamicTabTitleMode: DynamicTabTitleMode;
  sessionIds: readonly string[];
};

export function createCodingCliSessionSignalController(
  deps: CodingCliSessionSignalControllerDeps,
): CodingCliSessionSignalController {
  const outputScanners = new Map<string, CodingCliOutputScanner>();
  const outputScanDisabled = new Set<string>();
  let observedDynamicTabTitleMode = deps.getDynamicTabTitleMode();

  const handleDynamicTabTitleModeChange = (mode: DynamicTabTitleMode) => {
    if (mode === observedDynamicTabTitleMode) return;
    const previousMode = observedDynamicTabTitleMode;
    observedDynamicTabTitleMode = mode;
    // agent <-> all both keep live detection on; clearing would re-arm
    // exhausted startup scans and mis-tag ordinary mid-session output.
    if (previousMode === 'off' || mode === 'off') {
      outputScanners.clear();
      outputScanDisabled.clear();
    }
  };

  const getCurrentDynamicTabTitleMode = () => {
    const mode = deps.getDynamicTabTitleMode();
    handleDynamicTabTitleModeChange(mode);
    return mode;
  };

  const applyProvider = (sessionId: string, providerId: CodingCliProviderId | null) => {
    const session = deps.getSession(sessionId);
    if (!session) return;
    const nextProviderId = resolveCodingCliProviderIconUpdate({
      dynamicTabTitleMode: getCurrentDynamicTabTitleMode(),
      currentProviderId: session.codingCliProviderId,
      nextProviderId: providerId,
    });
    if (nextProviderId === undefined) return;
    deps.onUpdateSessionCodingCliProvider?.(sessionId, nextProviderId);
  };

  const handleCommandSubmitted = (sessionId: string, commandLine: string) => {
    if (!shouldUpdateCodingCliTabIcon(getCurrentDynamicTabTitleMode())) return;
    const provider = matchCodingCliProviderFromCommand(commandLine);
    if (!provider) return;
    outputScanners.delete(sessionId);
    outputScanDisabled.delete(sessionId);
    applyProvider(sessionId, provider.id);
  };

  const handleTerminalTitleChange = (sessionId: string, title: string | null) => {
    const session = deps.getSession(sessionId);
    if (!session) return;
    const dynamicTabTitleMode = getCurrentDynamicTabTitleMode();
    const trimmedTitle = title?.trim();
    const providerId = trimmedTitle
      ? inferCodingCliProviderFromTitleSignals(trimmedTitle)
      : undefined;
    const shouldStoreDynamicTitle =
      dynamicTabTitleMode === 'all'
      || (
        dynamicTabTitleMode === 'agent'
        && Boolean(session.codingCliProviderId || providerId)
      );
    deps.onUpdateSessionDynamicTitle?.(sessionId, shouldStoreDynamicTitle ? title : null);

    if (!shouldUpdateCodingCliTabIcon(dynamicTabTitleMode)) return;
    if (!trimmedTitle) {
      if (session.codingCliProviderId) {
        outputScanners.delete(sessionId);
        outputScanDisabled.delete(sessionId);
        applyProvider(sessionId, null);
      }
      return;
    }

    if (providerId) {
      if (!session.codingCliProviderId || session.codingCliProviderId !== providerId) {
        outputScanners.delete(sessionId);
        outputScanDisabled.delete(sessionId);
        applyProvider(sessionId, providerId);
      }
      return;
    }

    if (
      session.codingCliProviderId
      && shouldClearCodingCliProviderForTitle(trimmedTitle, session.codingCliProviderId)
    ) {
      outputScanners.delete(sessionId);
      outputScanDisabled.delete(sessionId);
      applyProvider(sessionId, null);
    }
  };

  const handleTerminalOutput = (sessionId: string, chunk: string) => {
    const dynamicTabTitleMode = getCurrentDynamicTabTitleMode();
    if (!chunk || outputScanDisabled.has(sessionId)) return;
    if (!shouldUpdateCodingCliTabIcon(dynamicTabTitleMode)) return;

    const session = deps.getSession(sessionId);
    if (!session) {
      outputScanners.delete(sessionId);
      outputScanDisabled.delete(sessionId);
      return;
    }
    if (session.codingCliProviderId) return;

    let scanner = outputScanners.get(sessionId);
    if (!scanner) {
      scanner = createCodingCliOutputScanner();
      outputScanners.set(sessionId, scanner);
    }

    const providerId = scanner.feed(chunk);
    if (providerId) {
      applyProvider(sessionId, providerId);
      return;
    }

    if (scanner.isExhausted()) {
      outputScanners.delete(sessionId);
      outputScanDisabled.add(sessionId);
    }
  };

  return {
    handleDynamicTabTitleModeChange,
    handleCommandSubmitted,
    handleTerminalOutput,
    handleTerminalTitleChange,
    forgetSession: (sessionId: string) => {
      outputScanners.delete(sessionId);
      outputScanDisabled.delete(sessionId);
    },
  };
}

export function useCodingCliSessionSignals(
  options: UseCodingCliSessionSignalsOptions,
): CodingCliSessionSignalController {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const controllerRef = useRef<CodingCliSessionSignalController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createCodingCliSessionSignalController({
      getDynamicTabTitleMode: () => optionsRef.current.dynamicTabTitleMode,
      getSession: (sessionId) => optionsRef.current.getSession(sessionId),
      onUpdateSessionCodingCliProvider: (sessionId, providerId) => {
        optionsRef.current.onUpdateSessionCodingCliProvider?.(sessionId, providerId);
      },
      onUpdateSessionDynamicTitle: (sessionId, title) => {
        optionsRef.current.onUpdateSessionDynamicTitle?.(sessionId, title);
      },
    });
  }

  const controller = controllerRef.current;
  const liveSessionIdsRef = useRef(new Set(options.sessionIds));
  useEffect(() => {
    controller.handleDynamicTabTitleModeChange(options.dynamicTabTitleMode);
  }, [controller, options.dynamicTabTitleMode]);
  useEffect(() => {
    const nextSessionIds = new Set(options.sessionIds);
    for (const sessionId of liveSessionIdsRef.current) {
      if (!nextSessionIds.has(sessionId)) controller.forgetSession(sessionId);
    }
    liveSessionIdsRef.current = nextSessionIds;
  }, [controller, options.sessionIds]);
  useEffect(() => () => {
    for (const sessionId of liveSessionIdsRef.current) {
      controller.forgetSession(sessionId);
    }
  }, [controller]);

  return controller;
}
