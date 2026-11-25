const MAX_REPORT = 24 * 1024;

/** Strip private OSC reports before forwarding terminal output. */
function createDirectoryReportStream(prefix, onReport) {
  let pending = '';
  let dropping = false;
  return function consume(chunk) {
    let input = pending + String(chunk);
    pending = '';
    let output = '';
    while (input) {
      if (dropping) {
        const end = /\x07|\x1b\\/.exec(input);
        if (!end) { pending = input.endsWith('\x1b') ? '\x1b' : ''; return output; }
        input = input.slice(end.index + end[0].length);
        dropping = false;
        continue;
      }
      const start = input.indexOf(prefix);
      if (start < 0) {
        let keep = Math.min(input.length, prefix.length - 1);
        while (keep > 0 && !prefix.startsWith(input.slice(-keep))) keep--;
        pending = keep ? input.slice(-keep) : '';
        return output + input.slice(0, input.length - keep);
      }
      output += input.slice(0, start);
      input = input.slice(start + prefix.length);
      const end = /\x07|\x1b\\/.exec(input);
      if (!end) {
        if (input.length > MAX_REPORT) { dropping = true; pending = input.endsWith('\x1b') ? '\x1b' : ''; }
        else pending = prefix + input;
        return output;
      }
      if (end.index <= MAX_REPORT) onReport(input.slice(0, end.index));
      input = input.slice(end.index + end[0].length);
    }
    return output;
  };
}

module.exports = { MAX_REPORT, createDirectoryReportStream };
