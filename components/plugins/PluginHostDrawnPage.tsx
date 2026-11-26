import { useHostDrawnPluginView } from '../../application/state/useHostDrawnPluginView';
import { PluginSettingsEntry } from './PluginSettingsEntry';
import { PluginRemoteSurface } from './PluginRemoteSurface';

export type PluginHostDrawnPageProps = Parameters<typeof useHostDrawnPluginView>[0] & {
  loadingLabel: string;
  pluginId: string;
};

type MinimalTreeNode = {
  type?: number;
  attributes?: Record<string, string>;
  children?: MinimalTreeNode[];
};

function hasFullBleedChrome(tree: unknown): boolean {
  if (!tree || typeof tree !== 'object') return false;
  const children = (tree as { children?: MinimalTreeNode[] }).children;
  if (!Array.isArray(children)) return false;
  // Check root and immediate child (hostDom wraps React trees in a mountRoot div).
  const check = (nodes: MinimalTreeNode[], depth: number): boolean => {
    for (const node of nodes) {
      if (node?.type !== 1) continue;
      if (node.attributes?.['data-plugin-chrome'] === 'full-bleed') return true;
      if (depth < 2 && Array.isArray(node.children) && check(node.children, depth + 1)) return true;
    }
    return false;
  };
  return check(children, 0);
}

export function PluginHostDrawnPage(props: PluginHostDrawnPageProps) {
  const view = useHostDrawnPluginView(props);
  if (!view.visible) return null;
  if (view.loading) return <p data-plugin-view-slot={props.slot.split(':')[0]} role="status" className="p-4 text-sm text-muted-foreground">{props.loadingLabel}</p>;
  const fullBleed = hasFullBleedChrome(view.tree);
  return <div className="relative isolate h-full min-h-0 w-full flex-1" data-plugin-view-slot={props.slot.split(':')[0]} data-plugin-chrome={fullBleed ? 'full-bleed' : undefined}>
    <PluginRemoteSurface key={`${props.viewId}:${props.version}:${props.slot}`} tree={view.tree} css={view.css} settled={view.settled} loadImage={view.loadImage} onEvent={view.sendEvent} />
    {!fullBleed && (
      <div className="absolute right-3 top-3 z-10" data-plugin-settings-entry="">
        <PluginSettingsEntry key={`${props.pluginId}:${props.version}`} pluginId={props.pluginId} />
      </div>
    )}
  </div>;
}
