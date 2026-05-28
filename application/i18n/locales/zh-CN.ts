import type { Messages } from './types';
import { zhCNCoreMessages } from './zh-CN/core';
import { zhCNVaultMessages } from './zh-CN/vault';
import { zhCNTerminalMessages } from './zh-CN/terminal';
import { zhCNAiMessages } from './zh-CN/ai';

export type { Messages } from './types';

const zhCN: Messages = {
  ...zhCNCoreMessages,
  ...zhCNVaultMessages,
  ...zhCNTerminalMessages,
  ...zhCNAiMessages,
};

export default zhCN;
