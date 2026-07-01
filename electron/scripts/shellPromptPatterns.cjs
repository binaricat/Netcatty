"use strict";

/** @see domain/snippetScript.ts DEFAULT_SHELL_PROMPT_PATTERNS */
const DEFAULT_SHELL_PROMPT_PATTERNS = ["# ", "$ ", "~# ", "~$ ", "% "];

/** @see domain/snippetScript.ts SHELL_PROMPT_END_REGEX */
const SHELL_PROMPT_END_REGEX = /(?:~[#$]\s*|[@][^\n]{0,120}[:][^\n]{0,120}[#$%]\s*)$/m;

function shellPromptPatterns() {
  return [...DEFAULT_SHELL_PROMPT_PATTERNS, SHELL_PROMPT_END_REGEX];
}

module.exports = {
  DEFAULT_SHELL_PROMPT_PATTERNS,
  SHELL_PROMPT_END_REGEX,
  shellPromptPatterns,
};
