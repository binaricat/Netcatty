import { zhCNMonitorMessages } from './zh-CN/monitor';
import type { Messages } from './types';
import { zhCNCoreMessages } from './zh-CN/core';
import { zhCNVaultMessages } from './zh-CN/vault';
import { zhCNTerminalMessages } from './zh-CN/terminal';
import { zhCNAiMessages } from './zh-CN/ai';
import { zhCnSystemManagerMessages } from './zh-CN/systemManager';
import { zhCNScriptsMessages } from './zh-CN/scripts';

export type { Messages } from './types';

const zhCN: Messages = {
  ...zhCNMonitorMessages,
  ...zhCNCoreMessages,
  ...zhCNVaultMessages,
  ...zhCNTerminalMessages,
  ...zhCNAiMessages,
  ...zhCnSystemManagerMessages,
  ...zhCNScriptsMessages,
};

export default zhCN;
