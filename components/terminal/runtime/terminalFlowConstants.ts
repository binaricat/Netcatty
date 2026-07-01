import terminalFlowConstants from "../../../infrastructure/config/terminalFlowConstants.json";

/**
 * Terminal output flow-control thresholds.
 *
 * Single source of truth: infrastructure/config/terminalFlowConstants.json
 * (aligned with VS Code FlowControlConstants).
 */
export const FLOW_HIGH_WATER_MARK = terminalFlowConstants.FLOW_HIGH_WATER_MARK;
export const FLOW_LOW_WATER_MARK = terminalFlowConstants.FLOW_LOW_WATER_MARK;
export const FLOW_CHAR_COUNT_ACK_SIZE = terminalFlowConstants.FLOW_CHAR_COUNT_ACK_SIZE;
export const MAX_PENDING_WRITE_COALESCE_BYTES =
  terminalFlowConstants.MAX_PENDING_WRITE_COALESCE_BYTES;
export const MAX_PENDING_WRITE_COALESCE_BYTES_FLOOD =
  terminalFlowConstants.MAX_PENDING_WRITE_COALESCE_BYTES_FLOOD;
export const MAX_TERMINAL_PLAIN_WRITE_CHUNK_BYTES =
  terminalFlowConstants.MAX_TERMINAL_PLAIN_WRITE_CHUNK_BYTES;
export const MAX_TERMINAL_UNBROKEN_WRITE_CHUNK_BYTES =
  terminalFlowConstants.MAX_TERMINAL_UNBROKEN_WRITE_CHUNK_BYTES;
export const MAX_TERMINAL_WRITE_QUEUE_DRAIN_BYTES =
  terminalFlowConstants.MAX_TERMINAL_WRITE_QUEUE_DRAIN_BYTES;
export const TERMINAL_LONG_LINE_PRESSURE_BYTES =
  terminalFlowConstants.TERMINAL_LONG_LINE_PRESSURE_BYTES;
export const TERMINAL_AUX_LONG_LINE_SCAN_LIMIT_CHARS =
  terminalFlowConstants.TERMINAL_AUX_LONG_LINE_SCAN_LIMIT_CHARS;
export const XTERM_WRITE_CALLBACK_FAST_PATH_MAX_BYTES =
  terminalFlowConstants.XTERM_WRITE_CALLBACK_FAST_PATH_MAX_BYTES;
export const XTERM_WRITE_CALLBACK_BATCH_BYTES =
  terminalFlowConstants.XTERM_WRITE_CALLBACK_BATCH_BYTES;
