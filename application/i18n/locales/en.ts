import type { Messages } from './types';
import { enCoreMessages } from './en/core';
import { enVaultMessages } from './en/vault';
import { enTerminalMessages } from './en/terminal';
import { enAiMessages } from './en/ai';

export type { Messages } from './types';

const en: Messages = {
  ...enCoreMessages,
  ...enVaultMessages,
  ...enTerminalMessages,
  ...enAiMessages,
};

export default en;
