import { enMonitorMessages } from './en/monitor';
import type { Messages } from './types';
import { enCoreMessages } from './en/core';
import { enVaultMessages } from './en/vault';
import { enTerminalMessages } from './en/terminal';
import { enAiMessages } from './en/ai';
import { enSystemManagerMessages } from './en/systemManager';
import { enScriptsMessages } from './en/scripts';

export type { Messages } from './types';

const en: Messages = {
  ...enMonitorMessages,
  ...enCoreMessages,
  ...enVaultMessages,
  ...enTerminalMessages,
  ...enAiMessages,
  ...enSystemManagerMessages,
  ...enScriptsMessages,
};

export default en;
