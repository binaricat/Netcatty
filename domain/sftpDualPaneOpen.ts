import { isPluginHostProtocol } from "./pluginConnection";

export type DualPaneSftpTab = {
  id: string;
  isLocal: boolean;
  hostId: string | null;
  endpointKey: string | null;
  hasConnection: boolean;
};

export function isReusableSftpConnectionStatus(
  status?: string | null,
): boolean {
  return status === "connected" || status === "connecting";
}

export function dualPaneTabFromPane(pane: {
  id: string;
  connection: {
    isLocal?: boolean;
    hostId?: string | null;
    status?: string | null;
  } | null;
}, endpointKey: string | null = null): DualPaneSftpTab {
  const live = isReusableSftpConnectionStatus(pane.connection?.status);
  return {
    id: pane.id,
    isLocal: live && !!pane.connection?.isLocal,
    hostId: pane.connection?.isLocal
      ? "local"
      : pane.connection?.hostId ?? null,
    endpointKey,
    hasConnection: live,
  };
}

export type DualPaneSftpPlan = {
  selectLeftTabId: string | null;
  connectLeftLocal: boolean;
  addLeftTab: boolean;
  selectRightTabId: string | null;
  connectRightHost: boolean;
  addRightTab: boolean;
};

export function canOpenDualPaneSftp(host: { protocol?: string }): boolean {
  const protocol = host.protocol ?? "ssh";
  if (protocol === "serial") return false;
  if (isPluginHostProtocol(protocol)) return false;
  return true;
}

export function planDualPaneSftpOpen(params: {
  leftTabs: DualPaneSftpTab[];
  rightTabs: DualPaneSftpTab[];
  hostId: string;
  hostEndpointKey: string;
}): DualPaneSftpPlan {
  const localLeft = params.leftTabs.find((tab) => tab.isLocal);
  const idleLeft = params.leftTabs.find((tab) => !tab.hasConnection);
  const matchingRight = params.rightTabs.find(
    (tab) => tab.hostId === params.hostId
      && tab.endpointKey === params.hostEndpointKey
      && tab.hasConnection,
  );
  const matchingDeadRight = params.rightTabs.find(
    (tab) => tab.hostId === params.hostId && !tab.hasConnection,
  );
  const idleRight = params.rightTabs.find((tab) => !tab.hasConnection);

  const leftReuse = localLeft ?? idleLeft;
  const rightReuse = matchingRight ?? matchingDeadRight ?? idleRight;

  return {
    selectLeftTabId: leftReuse?.id ?? null,
    connectLeftLocal: !localLeft,
    addLeftTab: !leftReuse && params.leftTabs.length > 0,
    selectRightTabId: rightReuse?.id ?? null,
    connectRightHost: !matchingRight,
    addRightTab: !rightReuse && params.rightTabs.length > 0,
  };
}

export type DualPaneSftpApi = {
  leftTabs: DualPaneSftpTab[];
  rightTabs: DualPaneSftpTab[];
  selectTab: (side: "left" | "right", tabId: string) => void;
  connect: (
    side: "left" | "right",
    host: { id: string } | "local",
    options?: { forceNewTab?: boolean; tabId?: string },
  ) => void;
};

function connectOptions(plan: {
  addTab: boolean;
  selectTabId: string | null;
}): { forceNewTab?: boolean; tabId?: string } | undefined {
  if (plan.addTab) return { forceNewTab: true };
  if (plan.selectTabId) return { tabId: plan.selectTabId };
  return undefined;
}

export function applyDualPaneSftpOpen<THost extends { id: string }>(
  api: DualPaneSftpApi,
  host: THost,
  hostEndpointKey: string,
): DualPaneSftpPlan {
  const plan = planDualPaneSftpOpen({
    leftTabs: api.leftTabs,
    rightTabs: api.rightTabs,
    hostId: host.id,
    hostEndpointKey,
  });

  if (plan.selectLeftTabId) {
    api.selectTab("left", plan.selectLeftTabId);
  }
  if (plan.connectLeftLocal) {
    api.connect(
      "left",
      "local",
      connectOptions({ addTab: plan.addLeftTab, selectTabId: plan.selectLeftTabId }),
    );
  }

  if (plan.selectRightTabId) {
    api.selectTab("right", plan.selectRightTabId);
  }
  if (plan.connectRightHost) {
    api.connect(
      "right",
      host,
      connectOptions({ addTab: plan.addRightTab, selectTabId: plan.selectRightTabId }),
    );
  }

  return plan;
}
