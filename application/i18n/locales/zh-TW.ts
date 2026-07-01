import type { Messages } from './types';
import { zhTWCoreMessages } from './zh-TW/core';
import { zhTWVaultMessages } from './zh-TW/vault';
import { zhTWTerminalMessages } from './zh-TW/terminal';
import { zhTWAiMessages } from './zh-TW/ai';
import { zhTwSystemManagerMessages } from './zh-TW/systemManager';
import { zhTWScriptsMessages } from './zh-TW/scripts';

export type { Messages } from './types';

const zhTW: Messages = {
  ...zhTWCoreMessages,
  ...zhTWVaultMessages,
  ...zhTWTerminalMessages,
  ...zhTWAiMessages,
  ...zhTwSystemManagerMessages,
  ...zhTWScriptsMessages,
};

export default zhTW;
