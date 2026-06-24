function longestSuffixMatchingPrefix(value, prefix) {
  const max = Math.min(value.length, Math.max(0, prefix.length - 1));
  for (let length = max; length > 0; length -= 1) {
    if (prefix.startsWith(value.slice(value.length - length))) {
      return length;
    }
  }
  return 0;
}

function findEarliestRewriteMatch(data, rewrites) {
  let result = null;
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
}

function longestSuffixMatchingAnyRewrite(data, rewrites) {
  let retained = 0;
  for (const rewrite of rewrites) {
    if (!rewrite.sentCommand) continue;
    retained = Math.max(retained, longestSuffixMatchingPrefix(data, rewrite.sentCommand));
  }
  return retained;
}

function createProgrammaticCommandLogRewriter() {
  let pending = "";
  const rewrites = [];

  return {
    queueRewrite(rewrite) {
      if (!rewrite?.sentCommand) return;
      rewrites.push({
        sentCommand: String(rewrite.sentCommand),
        displayCommand: String(rewrite.displayCommand ?? ""),
      });
    },
    append(input) {
      if (!input) return "";
      if (rewrites.length === 0) {
        const output = pending + input;
        pending = "";
        return output;
      }

      let data = pending + input;
      pending = "";
      let output = "";

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
    },
    finish() {
      const output = pending;
      pending = "";
      rewrites.length = 0;
      return output;
    },
  };
}

module.exports = {
  createProgrammaticCommandLogRewriter,
};
