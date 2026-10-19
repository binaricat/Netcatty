import { ruMonitorMessages } from './ru/monitor';
import type { Messages } from './types';
import { ruCoreMessages } from './ru/core';
import { ruVaultMessages } from './ru/vault';
import { ruTerminalMessages } from './ru/terminal';
import { ruAiMessages } from './ru/ai';
import { ruSystemManagerMessages } from './ru/systemManager';
import { ruScriptsMessages } from './ru/scripts';

export type { Messages } from './types';

const ru: Messages = {
  ...ruMonitorMessages,
  ...ruCoreMessages,
  ...ruVaultMessages,
  ...ruTerminalMessages,
  ...ruAiMessages,
  ...ruSystemManagerMessages,
  ...ruScriptsMessages,
};

export default ru;
