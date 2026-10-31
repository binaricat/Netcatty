import React from 'react';
import { useTerminalSessionGroup } from '../../application/state/useTerminalSessionGroup';
import { focusTerminalSessionInput } from '../terminal/focusTerminalSession';
import { TerminalSessionTabs } from './TerminalSessionTabs';

export function TerminalSessionGroupSection({ theme, t }: Pick<React.ComponentProps<typeof TerminalSessionTabs>, 'theme' | 't'>) {
  const state = useTerminalSessionGroup();
  if (!state.group) return null;
  return <TerminalSessionTabs
    key={state.group.id}
    sessions={state.sessions}
    selectedSessionId={state.activeSessionId}
    onSelect={id => {
      state.select(id);
      focusTerminalSessionInput(id);
    }}
    onAdd={() => { focusTerminalSessionInput(state.add()); }}
    onClose={state.close}
    onRename={state.rename}
    theme={theme}
    t={t}
  />;
}
