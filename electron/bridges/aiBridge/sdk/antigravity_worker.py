#!/usr/bin/env python3
"""JSONL bridge between Netcatty and the official Google Antigravity SDK."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from typing import Any


def emit(event: dict[str, Any]) -> None:
  sys.stdout.write(json.dumps(event, ensure_ascii=True, default=str) + "\n")
  sys.stdout.flush()


def json_value(value: Any) -> Any:
  if hasattr(value, "model_dump"):
    return value.model_dump(mode="json", exclude_none=True)
  try:
    json.dumps(value)
    return value
  except (TypeError, ValueError):
    return str(value)


async def run_turn(request: dict[str, Any]) -> None:
  try:
    from google.antigravity import Agent, LocalAgentConfig, types
    from google.antigravity.hooks import policy
  except ImportError as exc:
    raise RuntimeError(
        "Google Antigravity SDK is not installed for this Python interpreter. "
        "Install it with: python -m pip install google-antigravity"
    ) from exc

  cwd = os.path.abspath(str(request.get("cwd") or os.getcwd()))
  os.chdir(cwd)

  mcp_servers = [
      types.McpStdioServer(
          name=str(server["name"]),
          command=str(server["command"]),
          args=[str(arg) for arg in server.get("args", [])],
          env={str(key): str(value) for key, value in server.get("env", {}).items()},
      )
      for server in request.get("mcpServers", [])
      if server.get("name") and server.get("command")
  ]

  conversation_id = request.get("conversationId") or None
  config_kwargs: dict[str, Any] = {
      "capabilities": types.CapabilitiesConfig(enabled_tools=types.BuiltinTools.none()),
      "mcp_servers": mcp_servers,
      "policies": [policy.allow_all()] if mcp_servers else [],
      "workspaces": [cwd],
      "save_dir": os.path.abspath(str(request["saveDir"])),
      "app_data_dir": os.path.abspath(str(request["appDataDir"])),
  }
  if conversation_id:
    config_kwargs["conversation_id"] = str(conversation_id)
    config_kwargs["session_continuation_mode"] = (
        types.SessionContinuationMode.CREATE_OR_RESUME
    )
  if request.get("model"):
    config_kwargs["model"] = str(request["model"])

  prompt: Any = str(request.get("prompt") or "")
  attachments = []
  for attachment in request.get("attachments", []):
    attachment_path = str(attachment.get("path") or "")
    if attachment_path and os.path.isfile(attachment_path):
      attachments.append(types.from_file(attachment_path))
  if attachments:
    prompt = [prompt, *attachments]

  async with Agent(LocalAgentConfig(**config_kwargs)) as agent:
    await agent.conversation.send(prompt)
    emitted_session_id = None
    current_session_id = agent.conversation_id
    if current_session_id:
      emitted_session_id = current_session_id
      emit({"type": "session_id", "sessionId": current_session_id})

    reasoning_open = False
    seen_tool_ids: set[str] = set()
    completed_tool_ids: set[str] = set()
    usage_totals = {
        "inputTokens": 0,
        "cachedInputTokens": 0,
        "outputTokens": 0,
        "reasoningTokens": 0,
        "totalTokens": 0,
    }
    async for step in agent.conversation.receive_steps():
      if step.thinking_delta:
        reasoning_open = True
        emit({"type": "reasoning", "text": step.thinking_delta})
      if (
          step.source == types.StepSource.MODEL
          and step.target == types.StepTarget.USER
          and step.content_delta
      ):
        if reasoning_open:
          emit({"type": "reasoning_end"})
          reasoning_open = False
        emit({"type": "text", "text": step.content_delta})

      for call in step.tool_calls:
        call_id = call.id or f"{step.id}:{call.name}"
        if call_id not in seen_tool_ids:
          seen_tool_ids.add(call_id)
          emit({
              "type": "tool_call",
              "id": call_id,
              "name": str(call.name),
              "args": json_value(call.args),
          })
        if (
            call_id not in completed_tool_ids
            and step.status
            in (types.StepStatus.DONE, types.StepStatus.ERROR, types.StepStatus.CANCELED)
        ):
          completed_tool_ids.add(call_id)
          output = {
              "status": str(step.status.value),
              **({"error": step.error} if step.error else {}),
          }
          emit({
              "type": "tool_result",
              "id": call_id,
              "name": str(call.name),
              "output": output,
          })

      usage = step.usage_metadata
      if usage:
        usage_totals["inputTokens"] += usage.prompt_token_count or 0
        usage_totals["cachedInputTokens"] += usage.cached_content_token_count or 0
        usage_totals["outputTokens"] += usage.candidates_token_count or 0
        usage_totals["reasoningTokens"] += usage.thoughts_token_count or 0
        usage_totals["totalTokens"] += usage.total_token_count or 0

      current_session_id = agent.conversation_id
      if current_session_id and current_session_id != emitted_session_id:
        emitted_session_id = current_session_id
        emit({"type": "session_id", "sessionId": current_session_id})

    if reasoning_open:
      emit({"type": "reasoning_end"})

    if any(usage_totals.values()):
      emit({"type": "usage", **usage_totals})

  emit({"type": "done"})


async def main() -> None:
  line = await asyncio.to_thread(sys.stdin.readline)
  if not line:
    raise RuntimeError("Antigravity SDK worker did not receive a turn request")
  request = json.loads(line)
  if request.get("type") != "turn":
    raise RuntimeError("Antigravity SDK worker received an unsupported request")
  await run_turn(request)


if __name__ == "__main__":
  try:
    asyncio.run(main())
  except Exception as exc:  # The parent process owns user-facing error formatting.
    emit({"type": "error", "message": str(exc)})
    raise SystemExit(1)
