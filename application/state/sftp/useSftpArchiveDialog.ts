import { useCallback, useEffect, useRef, useState } from "react";
import {
  prepareSftpArchiveSelection,
  validateSftpArchiveName,
  withSftpArchiveExtension,
  type SftpArchiveCreationOptions,
  type SftpArchiveCreationResult,
  type SftpArchiveCreationTarget,
  type SftpArchiveFormat,
} from "../../../domain/sftpArchiveCreation";

export type SftpArchiveTarget = SftpArchiveCreationTarget;

export interface SftpArchiveDialogState {
  target: SftpArchiveTarget;
  directory: string;
  paths: string[];
  archiveName: string;
  format: SftpArchiveFormat;
  busy: boolean;
  error: string | null;
  confirmOverwrite: boolean;
}

interface UseSftpArchiveDialogParams {
  paneId: string;
  connectionId?: string;
  isLocal: boolean;
  isActive: boolean;
  t: (key: string, params?: Record<string, unknown>) => string;
  onCreateArchive?: (
    options: SftpArchiveCreationOptions,
    target: SftpArchiveTarget,
  ) => Promise<SftpArchiveCreationResult>;
  onCreated: (directory: string) => void;
}

export function useSftpArchiveDialog(params: UseSftpArchiveDialogParams) {
  const [state, setState] = useState<SftpArchiveDialogState | null>(null);
  const stateRef = useRef(state);
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const generation = useRef(0);

  const update = useCallback((next: SftpArchiveDialogState | null) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const matchesTarget = useCallback((target: SftpArchiveTarget) => {
    const current = paramsRef.current;
    return current.isActive && !current.isLocal
      && current.paneId === target.paneId
      && current.connectionId === target.connectionId;
  }, []);

  // A dialog belongs to the connection and pane on which it was opened. A tab
  // switch may leave its component mounted, so visibility is part of identity.
  useEffect(() => {
    if (stateRef.current && !matchesTarget(stateRef.current.target)) {
      generation.current += 1;
      update(null);
    }
  }, [params.paneId, params.connectionId, params.isLocal, params.isActive, matchesTarget, update]);

  useEffect(() => () => { generation.current += 1; }, []);

  const open = useCallback((sourcePaths: string[]) => {
    const current = paramsRef.current;
    if (!current.connectionId || current.isLocal || !current.isActive
      || !current.onCreateArchive || stateRef.current?.busy) return;
    generation.current += 1;
    const target = { paneId: current.paneId, connectionId: current.connectionId };
    try {
      const selection = prepareSftpArchiveSelection(sourcePaths);
      update({
        target,
        directory: selection.directory,
        paths: selection.paths,
        archiveName: withSftpArchiveExtension(selection.defaultName, "tar.gz"),
        format: "tar.gz",
        busy: false,
        error: null,
        confirmOverwrite: false,
      });
    } catch {
      update({
        target, directory: "", paths: [], archiveName: "", format: "tar.gz",
        busy: false, error: current.t("sftp.archive.invalidSelection"), confirmOverwrite: false,
      });
    }
  }, [update]);

  const close = useCallback(() => {
    if (stateRef.current?.busy) return;
    generation.current += 1;
    update(null);
  }, [update]);

  const setArchiveName = useCallback((archiveName: string) => {
    const current = stateRef.current;
    if (!current || current.busy) return;
    update({ ...current, archiveName, error: null, confirmOverwrite: false });
  }, [update]);

  const setFormat = useCallback((format: SftpArchiveFormat) => {
    const current = stateRef.current;
    if (!current || current.busy) return;
    update({
      ...current, format,
      archiveName: withSftpArchiveExtension(current.archiveName, format),
      error: null, confirmOverwrite: false,
    });
  }, [update]);

  const submit = useCallback(async (overwrite = false) => {
    const current = stateRef.current;
    const { onCreateArchive, t } = paramsRef.current;
    if (!current || current.busy || !onCreateArchive || !matchesTarget(current.target)
      || current.paths.length === 0 || (overwrite && !current.confirmOverwrite)) return;
    // Enter in the name field must not implicitly confirm replacement.
    if (current.confirmOverwrite && !overwrite) return;
    const validationError = validateSftpArchiveName(current.archiveName, current.format);
    if (validationError) {
      update({ ...current, error: t(validationError) });
      return;
    }
    const requestGeneration = generation.current;
    update({ ...current, busy: true, error: null });
    try {
      const result = await onCreateArchive({
        directory: current.directory,
        paths: current.paths,
        archiveName: current.archiveName,
        format: current.format,
        overwrite,
      }, current.target);
      if (generation.current !== requestGeneration || !matchesTarget(current.target)) return;
      if (!result.success) {
        update({
          ...current, busy: false,
          confirmOverwrite: result.code === "EEXIST",
          error: result.code === "EEXIST" ? null : result.error || t("sftp.archive.failed"),
        });
        return;
      }
      update(null);
      paramsRef.current.onCreated(current.directory);
    } catch (error) {
      if (generation.current !== requestGeneration || !matchesTarget(current.target)) return;
      update({
        ...current, busy: false, confirmOverwrite: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [matchesTarget, update]);

  return {
    state: state && matchesTarget(state.target) ? state : null,
    open, close, setArchiveName, setFormat, submit,
  };
}
