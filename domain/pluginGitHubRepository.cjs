"use strict";

function parsePluginGitHubRepository(input) {
  const message = "Use https://github.com/owner/repo, github.com/owner/repo or owner/repo (repository only; no credentials, query, fragment or extra paths)";
  if (typeof input !== "string" || input.length > 512) throw new Error(message);
  const value = input.trim();
  // Match the original text, before URL normalization can hide traversal or ports.
  const match = /^(?:(?:https?:\/\/)?github\.com\/)?([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?)\/([a-z0-9_.-]{1,100})\/?$/iu.exec(value);
  if (!match || match[1].includes("--")) throw new Error(message);
  const owner = match[1].toLowerCase();
  const repo = match[2].replace(/\.git$/iu, "").toLowerCase();
  if (!repo || repo === "." || repo === ".." || repo.endsWith(".git")) throw new Error(message);
  return Object.freeze({ owner, repo, repository: `${owner}/${repo}`, origin: `https://github.com/${owner}/${repo}` });
}

module.exports = { parsePluginGitHubRepository };
