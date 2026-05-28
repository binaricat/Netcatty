import type { ConnectionLog } from "../../domain/models";

export interface LogView {
  id: string;
  connectionLogId: string;
  log: ConnectionLog;
}

export const getLogViewTabId = (log: Pick<ConnectionLog, "id">): string => `log-${log.id}`;

export const addLogView = (views: LogView[], log: ConnectionLog): LogView[] => {
  if (views.some((view) => view.connectionLogId === log.id)) return views;
  return [
    ...views,
    {
      id: getLogViewTabId(log),
      connectionLogId: log.id,
      log,
    },
  ];
};

export const removeLogView = (views: LogView[], logViewId: string): LogView[] =>
  views.filter((view) => view.id !== logViewId);
