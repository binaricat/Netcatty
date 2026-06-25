import type { z } from 'zod';
import mcpAdapter from '@/electron/capabilities/adapters/mcpAdapter.cjs';

type ZodShape = Record<string, z.ZodType<unknown>>;

interface SharedMcpToolDefinition {
  toolName: string;
  description: string;
  inputSchema: ZodShape;
  implementationStatus?: string;
}

const { getMcpToolDefinition } = mcpAdapter as unknown as {
  getMcpToolDefinition: (
    toolName: string,
    surface: string,
    zod: typeof z,
  ) => SharedMcpToolDefinition | null;
};

export function getSharedBuiltinMcpToolDefinition(
  toolName: string,
  zod: typeof z,
): SharedMcpToolDefinition {
  const definition = getMcpToolDefinition(toolName, 'builtin', zod);
  if (!definition) {
    throw new Error(`Missing builtin MCP capability definition for ${toolName}`);
  }
  if (definition.implementationStatus === 'not_implemented') {
    throw new Error(`Builtin MCP capability ${definition.toolName} is marked not implemented`);
  }
  return definition;
}
