export {};
declare global {
  interface NetcattyBridge {
    monitorUpdate?(
      panels: import("../../domain/monitorRuntime").MonitorPanelDemand[],
    ): Promise<import("../../domain/monitorRuntime").MonitorSnapshot>;
    monitorSnapshot?(cursor?: import("../../domain/monitorRuntime").MonitorHistoryCursor): Promise<
      import("../../domain/monitorRuntime").MonitorSnapshot
    >;
    monitorStopAll?(): Promise<void>;
    monitorRetry?(hostId: string): Promise<void>;
  }
}
