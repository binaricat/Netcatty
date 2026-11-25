import { createProgrammaticCommandLogRewriter as createSharedProgrammaticCommandLogRewriter } from "@/domain/programmaticCommandLog.shared.cjs";

export interface ProgrammaticCommandLogRewrite {
  sentCommand: string;
  displayCommand: string;
}

export interface ProgrammaticCommandLogRewriter {
  queueRewrite(rewrite: ProgrammaticCommandLogRewrite): void;
  append(input: string): string;
  finish(): string;
}

export function createProgrammaticCommandLogRewriter(): ProgrammaticCommandLogRewriter {
  return createSharedProgrammaticCommandLogRewriter();
}
