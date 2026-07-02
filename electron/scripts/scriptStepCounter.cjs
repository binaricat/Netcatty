"use strict";

const STEP_MATCHERS = [
  { regex: /await\s+nct\.screen\.waitForPrompt\s*\(/g, label: "waitForPrompt" },
  { regex: /await\s+nct\.screen\.waitForAny\s*\(/g, label: "waitForAny" },
  { regex: /await\s+nct\.screen\.waitForText\s*\(/g, label: "waitForText" },
  { regex: /await\s+nct\.screen\.waitForRegex\s*\(/g, label: "waitForRegex" },
  { regex: /await\s+nct\.screen\.waitFor\s*\(/g, label: "waitFor" },
  { regex: /await\s+nct\.screen\.sendLine\s*\(/g, label: "sendLine" },
  { regex: /await\s+nct\.screen\.send\s*\(/g, label: "send" },
  { regex: /await\s+nct\.screen\.clear\s*\(/g, label: "clear" },
  { regex: /await\s+nct\.session\.sleep\s*\(/g, label: "sleep" },
  { regex: /await\s+nct\.sleep\s*\(/g, label: "sleep" },
  { regex: /await\s+nct\.session\.disconnect\s*\(/g, label: "disconnect" },
  { regex: /await\s+nct\.session\.startLog\s*\(/g, label: "startLog" },
  { regex: /nct\.log\s*\(/g, label: "log" },
];

function countScriptSteps(source) {
  const text = String(source || "");
  let total = 0;
  for (const matcher of STEP_MATCHERS) {
    const matches = text.match(matcher.regex);
    if (matches) total += matches.length;
  }
  return Math.max(total, 1);
}

module.exports = {
  STEP_MATCHERS,
  countScriptSteps,
};
