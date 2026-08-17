const ESCAPE = "\u001b";

/** xterm.js 生成的 OSC 颜色查询响应，包含动态颜色和调色板颜色两类。 */
const OSC_COLOR_QUERY_RESPONSE_PATTERN = new RegExp(
  `${ESCAPE}\\](?:4;\\d{1,3}|10|11|12);rgb:[0-9a-f]{1,4}\\/[0-9a-f]{1,4}\\/[0-9a-f]{1,4}(?:\\u0007|${ESCAPE}\\\\)`,
  "giu",
);

/**
 * 按需移除终端颜色查询回包。
 *
 * 只匹配带完整 OSC 控制前缀和终止符的响应，普通文本以及其他 ANSI/OSC
 * 数据保持不变。该函数只应作用于 xterm.js 的 onData 出口，不要用于远端
 * 输出解析，否则无法区分同样格式的颜色设置序列。
 */
export const stripOscColorQueryResponses = (data: string, enabled: boolean): string => (
  enabled ? data.replace(OSC_COLOR_QUERY_RESPONSE_PATTERN, "") : data
);
