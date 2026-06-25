import type { ModelMessage } from "ai";
import type { ChatMessage } from "./types.ts";

export const HARNESS_EVAL_REQUIRED_CATEGORIES = [
  "ssh-troubleshooting",
  "long-log-analysis",
  "sftp-file-inspection",
  "port-forwarding",
  "web-search-terminal",
  "permission-denied",
  "mcp-injection-failure",
  "context-413",
] as const;

export type HarnessEvalCategory = typeof HARNESS_EVAL_REQUIRED_CATEGORIES[number];

export const HARNESS_EVAL_REQUIRED_METRICS = [
  "successRate",
  "toolSteps",
  "promptTokens",
  "completionTokens",
  "compactionCount",
  "compressionCount",
  "userConfirmationCount",
  "errorTypes",
] as const;

export type HarnessEvalMetricId = typeof HARNESS_EVAL_REQUIRED_METRICS[number];

export type HarnessEvalBackendId = "catty" | "external-agent";

export interface HarnessEvalReplayExpectations {
  cattyIncludes: string[];
  cattyExcludes?: string[];
  externalIncludes: string[];
  externalExcludes?: string[];
  compactionIncludes?: string[];
}

export interface HarnessEvalFixture {
  messages: ChatMessage[];
  modelMessages?: ModelMessage[];
}

export interface HarnessEvalTask {
  id: string;
  title: string;
  category: HarnessEvalCategory;
  goal: string;
  replayTargets: HarnessEvalBackendId[];
  metrics: HarnessEvalMetricId[];
  fixture: HarnessEvalFixture;
  expectedReplay: HarnessEvalReplayExpectations;
}

export interface HarnessEvalRunMetrics {
  toolSteps: number;
  promptTokens: number;
  completionTokens: number;
  compactionCount: number;
  compressionCount: number;
  userConfirmationCount: number;
  errorTypes: string[];
}

export interface HarnessEvalRunRecord {
  taskId: string;
  backendId: HarnessEvalBackendId;
  succeeded: boolean;
  metrics: HarnessEvalRunMetrics;
}

export interface HarnessEvalRunSummary extends HarnessEvalRunMetrics {
  runCount: number;
  successCount: number;
  successRate: number;
}

export interface HarnessEvalTaskSetValidation {
  missingCategories: HarnessEvalCategory[];
  tasksMissingBackends: string[];
  tasksMissingMetrics: string[];
}

const ALL_REPLAY_TARGETS: HarnessEvalBackendId[] = ["catty", "external-agent"];
const ALL_REQUIRED_METRICS = [...HARNESS_EVAL_REQUIRED_METRICS];

function chatMessage(
  id: string,
  role: ChatMessage["role"],
  content: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    role,
    content,
    timestamp: 1,
    ...extra,
  };
}

function assistantToolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
): ChatMessage {
  return chatMessage(id, "assistant", "", {
    toolCalls: [{ id: `${id}-call`, name, arguments: args }],
  });
}

function toolResult(
  id: string,
  callOwnerId: string,
  content: string,
  isError = false,
): ChatMessage {
  return chatMessage(id, "tool", "", {
    toolResults: [{ toolCallId: `${callOwnerId}-call`, content, isError }],
  });
}

function longOutput(marker: string, repetitions = 240): string {
  return Array.from({ length: repetitions }, (_, index) => `${marker} line ${index}`).join("\n");
}

export const HARNESS_EVAL_TASKS: HarnessEvalTask[] = [
  {
    id: "ssh-service-failure",
    title: "SSH service failure triage",
    category: "ssh-troubleshooting",
    goal: "Diagnose a failing remote service over SSH while preserving the command provenance in replay.",
    replayTargets: ALL_REPLAY_TARGETS,
    metrics: ALL_REQUIRED_METRICS,
    fixture: {
      messages: [
        chatMessage("ssh-u1", "user", "SSH host prod-web cannot reach nginx; inspect service status and keep commands read-only."),
        assistantToolCall("ssh-a1", "terminal_execute", {
          command: "ssh prod-web 'systemctl status nginx --no-pager'",
        }),
        toolResult(
          "ssh-tool1",
          "ssh-a1",
          `${longOutput("NGINX_STATUS")}\nActive: failed (Result: exit-code)\nBind address 10.0.0.8 is unavailable.`,
          true,
        ),
        chatMessage("ssh-a2", "assistant", "nginx failed because the configured bind address 10.0.0.8 is unavailable."),
      ],
    },
    expectedReplay: {
      cattyIncludes: ["Historical terminal output omitted", "systemctl status nginx", "10.0.0.8 is unavailable"],
      cattyExcludes: ["NGINX_STATUS line 10"],
      externalIncludes: ["Historical terminal output omitted", "systemctl status nginx", "10.0.0.8 is unavailable"],
      externalExcludes: ["NGINX_STATUS line 10"],
    },
  },
  {
    id: "long-log-error-window",
    title: "Long terminal log analysis",
    category: "long-log-analysis",
    goal: "Replay a large terminal selection as metadata plus preview instead of resending the raw log bytes.",
    replayTargets: ALL_REPLAY_TARGETS,
    metrics: ALL_REQUIRED_METRICS,
    fixture: {
      messages: [
        chatMessage("log-u1", "user", "Find the first error burst in this long deploy log.", {
          attachments: [
            {
              base64Data: "LOG_BYTES".repeat(20_000),
              mediaType: "text/plain",
              filename: "deploy.log",
              terminalSelection: true,
              previewText: "ERROR rate spike near line 18842 after migration step 7",
              lineCount: 25_000,
            },
          ],
        }),
        chatMessage("log-a1", "assistant", "The useful window is around migration step 7, not the full log."),
      ],
    },
    expectedReplay: {
      cattyIncludes: ["Historical terminal selection omitted", "ERROR rate spike near line 18842"],
      cattyExcludes: ["LOG_BYTESLOG_BYTES"],
      externalIncludes: ["Historical terminal selection omitted", "ERROR rate spike near line 18842"],
      externalExcludes: ["LOG_BYTESLOG_BYTES"],
    },
  },
  {
    id: "sftp-config-read",
    title: "SFTP file inspection",
    category: "sftp-file-inspection",
    goal: "Inspect a remote config file through a read-only SFTP tool and keep the result interpretable in replay.",
    replayTargets: ALL_REPLAY_TARGETS,
    metrics: ALL_REQUIRED_METRICS,
    fixture: {
      messages: [
        chatMessage("sftp-u1", "user", "Read /etc/ssh/sshd_config over SFTP and explain whether password login is enabled. Do not write files."),
        assistantToolCall("sftp-a1", "sftp_read_file", {
          hostId: "prod-web",
          path: "/etc/ssh/sshd_config",
        }),
        toolResult(
          "sftp-tool1",
          "sftp-a1",
          "PasswordAuthentication no\nPermitRootLogin prohibit-password\nAllowUsers deploy",
        ),
      ],
    },
    expectedReplay: {
      cattyIncludes: ["sftp_read_file", "PasswordAuthentication no"],
      externalIncludes: ["sftp_read_file", "PasswordAuthentication no"],
    },
  },
  {
    id: "port-forward-bind-conflict",
    title: "Port forwarding bind conflict",
    category: "port-forwarding",
    goal: "Diagnose a local port-forward conflict while replay keeps the failing command and assistant conclusion.",
    replayTargets: ALL_REPLAY_TARGETS,
    metrics: ALL_REQUIRED_METRICS,
    fixture: {
      messages: [
        chatMessage("pf-u1", "user", "Port forward local 15432 to db.internal:5432 through jump is failing; diagnose without firewall changes."),
        assistantToolCall("pf-a1", "terminal_execute", {
          command: "ssh -N -L 15432:db.internal:5432 jump",
        }),
        toolResult(
          "pf-tool1",
          "pf-a1",
          `${longOutput("PORT_FORWARD_TRACE", 80)}\nbind [127.0.0.1]:15432: Address already in use`,
          true,
        ),
        chatMessage("pf-a2", "assistant", "The local port 15432 is already in use; choose a free local port before retrying."),
      ],
    },
    expectedReplay: {
      cattyIncludes: ["Historical terminal output omitted", "15432:db.internal:5432", "already in use"],
      cattyExcludes: ["PORT_FORWARD_TRACE line 10"],
      externalIncludes: ["Historical terminal output omitted", "15432:db.internal:5432", "already in use"],
      externalExcludes: ["PORT_FORWARD_TRACE line 10"],
    },
  },
  {
    id: "web-search-then-terminal",
    title: "Web search plus terminal verification",
    category: "web-search-terminal",
    goal: "Combine web context with a terminal verification command and replay both steps compactly.",
    replayTargets: ALL_REPLAY_TARGETS,
    metrics: ALL_REQUIRED_METRICS,
    fixture: {
      messages: [
        chatMessage("web-u1", "user", "Check the latest OpenSSH remediation guidance, then verify prod-web's ssh version."),
        assistantToolCall("web-a1", "web_search", {
          query: "OpenSSH security remediation guidance",
        }),
        toolResult("web-tool1", "web-a1", "OpenSSH 9.7p1 includes the relevant remediation guidance."),
        assistantToolCall("web-a2", "terminal_execute", {
          command: "ssh prod-web 'ssh -V'",
        }),
        toolResult("web-tool2", "web-a2", `${longOutput("SSH_VERSION_TRACE", 80)}\nOpenSSH_9.6p1`, false),
      ],
    },
    expectedReplay: {
      cattyIncludes: ["web_search", "OpenSSH 9.7p1", "ssh -V", "Historical terminal output omitted"],
      cattyExcludes: ["SSH_VERSION_TRACE line 10"],
      externalIncludes: ["web_search", "OpenSSH 9.7p1", "ssh -V", "Historical terminal output omitted"],
      externalExcludes: ["SSH_VERSION_TRACE line 10"],
    },
  },
  {
    id: "sudo-approval-denied",
    title: "Permission denial handling",
    category: "permission-denied",
    goal: "Record a denied confirmation path and keep the denial visible in later replay.",
    replayTargets: ALL_REPLAY_TARGETS,
    metrics: ALL_REQUIRED_METRICS,
    fixture: {
      messages: [
        chatMessage("perm-u1", "user", "Check sshd logs, but ask before sudo and continue safely if permission is denied."),
        chatMessage("perm-a1", "assistant", "", {
          toolCalls: [
            {
              id: "perm-a1-call",
              name: "terminal_execute",
              arguments: { command: "sudo journalctl -u sshd --since -1h" },
            },
          ],
          pendingApproval: {
            approvalId: "approval-denied-1",
            toolCallId: "perm-a1-call",
            toolName: "terminal_execute",
            toolArgs: { command: "sudo journalctl -u sshd --since -1h" },
            status: "denied",
          },
        }),
        toolResult("perm-tool1", "perm-a1", "Approval denied by user; sudo command was not executed.", true),
        chatMessage("perm-a2", "assistant", "User confirmation was denied; continue with non-sudo checks only."),
      ],
    },
    expectedReplay: {
      cattyIncludes: ["sudo journalctl", "status=error", "confirmation was denied"],
      externalIncludes: ["sudo journalctl", "status=error", "confirmation was denied"],
    },
  },
  {
    id: "mcp-injection-failure",
    title: "MCP injection failure recovery",
    category: "mcp-injection-failure",
    goal: "Capture an external-agent MCP startup failure and the fallback decision for replay.",
    replayTargets: ALL_REPLAY_TARGETS,
    metrics: ALL_REQUIRED_METRICS,
    fixture: {
      messages: [
        chatMessage("mcp-u1", "user", "Start the external agent with Netcatty MCP tools and report if tool injection fails."),
        chatMessage("mcp-a1", "assistant", "MCP injection failed: NETCATTY_TOOL_CLI_DISCOVERY_FILE was missing, so no Netcatty MCP tools were exposed."),
        chatMessage("mcp-u2", "user", "Retry only after the environment is fixed."),
      ],
    },
    expectedReplay: {
      cattyIncludes: ["MCP injection failed", "NETCATTY_TOOL_CLI_DISCOVERY_FILE"],
      externalIncludes: ["MCP injection failed", "NETCATTY_TOOL_CLI_DISCOVERY_FILE"],
    },
  },
  {
    id: "request-too-large-413",
    title: "413 long-context recovery",
    category: "context-413",
    goal: "Ensure long context can be compacted while preserving the 413 cause and current objective.",
    replayTargets: ALL_REPLAY_TARGETS,
    metrics: ALL_REQUIRED_METRICS,
    fixture: {
      messages: [
        chatMessage("ctx-u1", "user", "A previous request hit provider 413; compress transcript and keep the current SSH troubleshooting goal."),
        assistantToolCall("ctx-a1", "terminal_execute", {
          command: "ssh prod-web 'journalctl -u nginx --no-pager'",
        }),
        toolResult("ctx-tool1", "ctx-a1", `${longOutput("JOURNAL_413", 300)}\nnginx bind failure remains current`, true),
        chatMessage("ctx-u2", "user", "Continue after compaction without losing the nginx bind failure."),
      ],
      modelMessages: [
        { role: "user", content: `Provider returned 413 request too large. ${"old context ".repeat(500)}` },
        { role: "assistant", content: `We need payload compression and compaction. ${"analysis ".repeat(500)}` },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "ctx-a1-call",
              toolName: "terminal_execute",
              output: { type: "text", value: "nginx bind failure remains current" },
            },
          ],
        },
        { role: "user", content: "Continue with the current SSH troubleshooting goal." },
      ],
    },
    expectedReplay: {
      cattyIncludes: ["Historical terminal output omitted", "journalctl -u nginx", "nginx bind failure"],
      cattyExcludes: ["JOURNAL_413 line 10"],
      externalIncludes: ["Historical terminal output omitted", "journalctl -u nginx", "nginx bind failure"],
      externalExcludes: ["JOURNAL_413 line 10"],
      compactionIncludes: ["413 request too large", "nginx bind failure remains current"],
    },
  },
];

export function validateHarnessEvalTaskSet(
  tasks: HarnessEvalTask[] = HARNESS_EVAL_TASKS,
): HarnessEvalTaskSetValidation {
  const categories = new Set(tasks.map((task) => task.category));
  const missingCategories = HARNESS_EVAL_REQUIRED_CATEGORIES.filter((category) => !categories.has(category));
  const tasksMissingBackends = tasks
    .filter((task) => !task.replayTargets.includes("catty") || !task.replayTargets.includes("external-agent"))
    .map((task) => task.id);
  const tasksMissingMetrics = tasks
    .filter((task) => HARNESS_EVAL_REQUIRED_METRICS.some((metric) => !task.metrics.includes(metric)))
    .map((task) => task.id);

  return {
    missingCategories,
    tasksMissingBackends,
    tasksMissingMetrics,
  };
}

export function summarizeHarnessEvalRuns(records: HarnessEvalRunRecord[]): HarnessEvalRunSummary {
  const summary = records.reduce<HarnessEvalRunSummary>(
    (current, record) => {
      current.runCount += 1;
      if (record.succeeded) current.successCount += 1;
      current.toolSteps += record.metrics.toolSteps;
      current.promptTokens += record.metrics.promptTokens;
      current.completionTokens += record.metrics.completionTokens;
      current.compactionCount += record.metrics.compactionCount;
      current.compressionCount += record.metrics.compressionCount;
      current.userConfirmationCount += record.metrics.userConfirmationCount;
      for (const errorType of record.metrics.errorTypes) {
        if (!current.errorTypes.includes(errorType)) current.errorTypes.push(errorType);
      }
      return current;
    },
    {
      runCount: 0,
      successCount: 0,
      successRate: 0,
      toolSteps: 0,
      promptTokens: 0,
      completionTokens: 0,
      compactionCount: 0,
      compressionCount: 0,
      userConfirmationCount: 0,
      errorTypes: [],
    },
  );

  summary.successRate = summary.runCount > 0 ? summary.successCount / summary.runCount : 0;
  summary.errorTypes.sort();
  return summary;
}
