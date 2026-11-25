import React from 'react';

import { InlineRenameInput } from '../ui/inline-rename-input';

type HostTreeGroupInlineRenameInputProps = {
  initialName: string;
  onCommit: (name: string) => boolean | void | Promise<boolean | void>;
  onCancel: () => void;
  className?: string;
  style?: React.CSSProperties;
};

export const HostTreeGroupInlineRenameInput: React.FC<HostTreeGroupInlineRenameInputProps> = (
  props,
) => (
  <InlineRenameInput
    data-inline-group-edit="true"
    {...props}
  />
);
