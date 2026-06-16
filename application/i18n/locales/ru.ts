import type { Messages } from './types';
import { ruCoreMessages } from './ru/core';
import { ruVaultMessages } from './ru/vault';
import { ruTerminalMessages } from './ru/terminal';
import { ruAiMessages } from './ru/ai';
import { ruSystemManagerMessages } from './ru/systemManager';

export type { Messages } from './types';

const ru: Messages = {
  ...ruCoreMessages,
  ...ruVaultMessages,
  ...ruTerminalMessages,
  ...ruAiMessages,
  ...ruSystemManagerMessages,
};

export default ru;
