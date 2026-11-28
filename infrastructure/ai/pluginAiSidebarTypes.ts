export interface PluginAISidebarPrompt {
  readonly label: string;
  readonly prompt: string;
}

export interface PluginAISidebarContextSnapshot {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly viewId: string;
  readonly title?: string;
  readonly subtitle?: string;
  readonly summary?: string;
  readonly suggestedPrompts?: readonly PluginAISidebarPrompt[];
  readonly updatedAt: number;
}

export interface PluginAISidebarToolSpec {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly risk: 'read' | 'write';
  readonly viewId?: string;
}

export interface PluginAISidebarTurnContext {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly viewId: string;
  readonly title?: string;
  readonly subtitle?: string;
  readonly summary?: string;
  readonly tools: readonly PluginAISidebarToolSpec[];
}

export interface PluginDynamicToolPolicy {
  readonly write: boolean;
  readonly capabilityId: string;
}
