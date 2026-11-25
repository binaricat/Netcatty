interface SharedProgrammaticCommandLogRewrite {
  sentCommand: string;
  displayCommand: string;
}

interface SharedProgrammaticCommandLogRewriter {
  queueRewrite(rewrite: SharedProgrammaticCommandLogRewrite): void;
  append(input: string): string;
  finish(): string;
}

declare module "./programmaticCommandLog.shared.cjs" {
  export function createProgrammaticCommandLogRewriter(): SharedProgrammaticCommandLogRewriter;
}

declare module "@/domain/programmaticCommandLog.shared.cjs" {
  export function createProgrammaticCommandLogRewriter(): SharedProgrammaticCommandLogRewriter;
}
