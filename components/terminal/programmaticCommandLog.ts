export interface ProgrammaticCommandLogRewrite {
  sentCommand: string;
  displayCommand: string;
}

export interface ProgrammaticCommandLogRewriter {
  queueRewrite(rewrite: ProgrammaticCommandLogRewrite): void;
  append(input: string): string;
  finish(): string;
}

const longestSuffixMatchingPrefix = (value: string, prefix: string): number => {
  const max = Math.min(value.length, Math.max(0, prefix.length - 1));
  for (let length = max; length > 0; length -= 1) {
    if (prefix.startsWith(value.slice(value.length - length))) {
      return length;
    }
  }
  return 0;
};

const findEarliestRewriteMatch = (
  data: string,
  rewrites: ProgrammaticCommandLogRewrite[],
): { index: number; rewriteIndex: number } | null => {
  let result: { index: number; rewriteIndex: number } | null = null;

  rewrites.forEach((rewrite, rewriteIndex) => {
    if (!rewrite.sentCommand) return;
    const index = data.indexOf(rewrite.sentCommand);
    if (index === -1) return;
    if (
      !result ||
      index < result.index ||
      (index === result.index && rewriteIndex < result.rewriteIndex)
    ) {
      result = { index, rewriteIndex };
    }
  });

  return result;
};

const longestSuffixMatchingAnyRewrite = (
  data: string,
  rewrites: ProgrammaticCommandLogRewrite[],
): number => {
  let retained = 0;
  for (const rewrite of rewrites) {
    if (!rewrite.sentCommand) continue;
    retained = Math.max(retained, longestSuffixMatchingPrefix(data, rewrite.sentCommand));
  }
  return retained;
};

export function createProgrammaticCommandLogRewriter(): ProgrammaticCommandLogRewriter {
  let pending = "";
  const rewrites: ProgrammaticCommandLogRewrite[] = [];

  const appendWithActiveRewrite = (input: string): string => {
    let data = pending + input;
    pending = "";
    let output = "";

    for (let i = rewrites.length - 1; i >= 0; i -= 1) {
      if (!rewrites[i].sentCommand) rewrites.splice(i, 1);
    }

    while (data && rewrites.length > 0) {
      const match = findEarliestRewriteMatch(data, rewrites);
      if (match) {
        const [rewrite] = rewrites.splice(match.rewriteIndex, 1);
        output += data.slice(0, match.index);
        output += rewrite.displayCommand;
        data = data.slice(match.index + rewrite.sentCommand.length);
        continue;
      }

      const retained = longestSuffixMatchingAnyRewrite(data, rewrites);
      const emitLength = data.length - retained;
      output += data.slice(0, emitLength);
      pending = data.slice(emitLength);
      return output;
    }

    return output + data;
  };

  return {
    queueRewrite(rewrite: ProgrammaticCommandLogRewrite): void {
      rewrites.push(rewrite);
    },
    append(input: string): string {
      if (!input) return "";
      if (rewrites.length === 0) {
        const output = pending + input;
        pending = "";
        return output;
      }
      return appendWithActiveRewrite(input);
    },
    finish(): string {
      const output = pending;
      pending = "";
      rewrites.length = 0;
      return output;
    },
  };
}
