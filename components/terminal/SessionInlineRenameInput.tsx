import React from 'react';

import { InlineRenameInput } from '../ui/inline-rename-input';

type SessionInlineRenameInputProps = {
  initialName: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
  className?: string;
  style?: React.CSSProperties;
};

export const SessionInlineRenameInput: React.FC<SessionInlineRenameInputProps> = (
  props,
) => (
  <InlineRenameInput
    data-session-inline-rename="true"
    {...props}
  />
);
