import assert from "node:assert/strict";
import test from "node:test";

import {
  HARNESS_EVAL_TASKS,
  summarizeHarnessEvalRuns,
  validateHarnessEvalTaskSet,
  type HarnessEvalTask,
} from "../../infrastructure/ai/harnessEval.ts";
import type { ChatMessage, ToolCall, ToolResult } from "../../infrastructure/ai/types.ts";
import {
  formatMessagesForCompaction,
  prepareContextCompaction,
} from "../../infrastructure/ai/contextCompaction.ts";
import {
  buildHistoricalToolReplayMaps,
  buildHistoricalToolResultReplayText,
  buildHistoricalUserReplayContent,
} from "./cattyHistoryReplay.ts";
import { buildExternalAgentHistoryMessages } from "./externalAgentHistory.ts";

function buildCattyReplayText(messages: ChatMessage[]): string {
  const { toolCallByToolResult } = buildHistoricalToolReplayMaps(messages);
  const parts: string[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      parts.push(buildHistoricalUserReplayContent(message.content, message.attachments ?? []));
      continue;
    }

    if (message.role === "assistant") {
      if (message.content) parts.push(message.content);
      for (const toolCall of message.toolCalls ?? []) {
        parts.push(formatToolCall(toolCall));
      }
      continue;
    }

    if (message.role === "tool") {
      for (const result of message.toolResults ?? []) {
        parts.push(formatToolResult(result, toolCallByToolResult.get(result)));
      }
    }
  }

  return parts.filter(Boolean).join("\n---\n");
}

function formatToolCall(toolCall: ToolCall): string {
  return `Tool call: ${toolCall.name}(${JSON.stringify(toolCall.arguments)})`;
}

function formatToolResult(result: ToolResult, toolCall?: ToolCall): string {
  return `Tool result (${result.toolCallId}): ${buildHistoricalToolResultReplayText(result, toolCall)}`;
}

function assertReplayExpectations(
  text: string,
  includes: string[],
  excludes: string[] = [],
): void {
  for (const expected of includes) {
    assert.match(text, new RegExp(escapeRegExp(expected)), `expected replay to include "${expected}"`);
  }
  for (const forbidden of excludes) {
    assert.doesNotMatch(text, new RegExp(escapeRegExp(forbidden)), `expected replay to omit "${forbidden}"`);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("harness eval task set covers every required category, backend, and metric", () => {
  const validation = validateHarnessEvalTaskSet();

  assert.deepEqual(validation, {
    missingCategories: [],
    tasksMissingBackends: [],
    tasksMissingMetrics: [],
  });
  assert.equal(HARNESS_EVAL_TASKS.length, 8);
});

test("harness eval Catty replay fixtures keep provenance while omitting bulky historical payloads", () => {
  for (const task of HARNESS_EVAL_TASKS) {
    const replayText = buildCattyReplayText(task.fixture.messages);

    assertReplayExpectations(
      replayText,
      task.expectedReplay.cattyIncludes,
      task.expectedReplay.cattyExcludes,
    );
  }
});

test("harness eval external-agent replay fixtures are available for every task", () => {
  for (const task of HARNESS_EVAL_TASKS) {
    const replayText = buildExternalAgentHistoryMessages(task.fixture.messages)
      .map((message) => message.content)
      .join("\n---\n");

    assertReplayExpectations(
      replayText,
      task.expectedReplay.externalIncludes,
      task.expectedReplay.externalExcludes,
    );
  }
});

test("harness eval 413 fixture compacts long context without losing the current objective", async () => {
  const task = getTask("request-too-large-413");
  assert.ok(task.fixture.modelMessages, "413 fixture must include model messages");

  const result = await prepareContextCompaction({
    messages: task.fixture.modelMessages,
    contextWindow: 120,
    protectRecentMessages: 1,
    summarize: async (messagesToSummarize) => formatMessagesForCompaction(messagesToSummarize),
  });

  assert.equal(result.didCompact, true);
  const compactedText = result.messages.map((message) => JSON.stringify(message.content)).join("\n");
  assertReplayExpectations(compactedText, task.expectedReplay.compactionIncludes ?? []);
});

test("summarizeHarnessEvalRuns records success rate, usage, confirmations, compactions, and errors", () => {
  const summary = summarizeHarnessEvalRuns([
    {
      taskId: "ssh-service-failure",
      backendId: "catty",
      succeeded: true,
      metrics: {
        toolSteps: 2,
        promptTokens: 100,
        completionTokens: 40,
        compactionCount: 1,
        compressionCount: 0,
        userConfirmationCount: 0,
        errorTypes: [],
      },
    },
    {
      taskId: "sudo-approval-denied",
      backendId: "external-agent",
      succeeded: false,
      metrics: {
        toolSteps: 1,
        promptTokens: 80,
        completionTokens: 20,
        compactionCount: 0,
        compressionCount: 1,
        userConfirmationCount: 1,
        errorTypes: ["permission-denied", "tool-error"],
      },
    },
  ]);

  assert.deepEqual(summary, {
    runCount: 2,
    successCount: 1,
    successRate: 0.5,
    toolSteps: 3,
    promptTokens: 180,
    completionTokens: 60,
    compactionCount: 1,
    compressionCount: 1,
    userConfirmationCount: 1,
    errorTypes: ["permission-denied", "tool-error"],
  });
});

function getTask(taskId: string): HarnessEvalTask {
  const task = HARNESS_EVAL_TASKS.find((candidate) => candidate.id === taskId);
  assert.ok(task, `missing task fixture ${taskId}`);
  return task;
}
