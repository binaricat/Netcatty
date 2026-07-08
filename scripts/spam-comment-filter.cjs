"use strict";

const TRUSTED_AUTHOR_ASSOCIATIONS = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);

const DANGEROUS_FILE_EXTENSION =
  "(?:zip|7z|rar|tar\\.gz|tgz|exe|msi|dmg|pkg|deb|rpm|appimage|bat|cmd|ps1|scr|vbs)";

const dangerousFilePattern = new RegExp(
  `(?:^|[\\s([<"'=])([^\\s()[\\]<>\"']+\\.${DANGEROUS_FILE_EXTENSION})(?=$|[\\s)\\]>\"']|[.,!?;:](?:$|\\s))`,
  "gi"
);

const suspiciousFileNamePattern = new RegExp(
  `\\b(?:patch|hotfix|fix|update|repair|solution|workaround|netcatty)[\\w.-]*\\.${DANGEROUS_FILE_EXTENSION}\\b`,
  "i"
);

const baitPatterns = [
  /\bquick\s+(?:patch|fix|hotfix)\b/i,
  /\bi\s+found\s+(?:a\s+)?(?:quick\s+)?(?:patch|fix|hotfix|solution)\b/i,
  /\b(?:download|use|try|install|apply)\s+(?:this|the)\s+(?:patch|fix|hotfix|update|zip|file)\b/i,
  /\b(?:fixes|fixed|patches|repairs)\s+(?:the|this|that|those)\b/i,
  /\b(?:backend|encoding|character mapping|black boxes|terminal rendering|sftp module)\b/i,
];

function normalizeAssociation(authorAssociation) {
  return String(authorAssociation || "").trim().toUpperCase();
}

function isTrustedAuthor(authorAssociation) {
  return TRUSTED_AUTHOR_ASSOCIATIONS.has(normalizeAssociation(authorAssociation));
}

function extractDangerousFiles(body) {
  const files = [];
  for (const match of body.matchAll(dangerousFilePattern)) {
    files.push(match[1]);
  }
  return [...new Set(files)];
}

function matchingBaitPatterns(body) {
  return baitPatterns
    .filter((pattern) => pattern.test(body))
    .map((pattern) => pattern.source);
}

function detectSpamComment({ body, authorAssociation, userType } = {}) {
  const normalizedBody = String(body || "").replace(/\s+/g, " ").trim();
  const dangerousFiles = extractDangerousFiles(normalizedBody);
  const baitMatches = matchingBaitPatterns(normalizedBody);
  const hasSuspiciousFileName = dangerousFiles.some((file) =>
    suspiciousFileNamePattern.test(file)
  );
  const trustedAuthor = isTrustedAuthor(authorAssociation);
  const botAuthor = String(userType || "").toLowerCase() === "bot";

  const reasons = [];
  let score = 0;

  if (dangerousFiles.length > 0) {
    score += 3;
    reasons.push(`dangerous downloadable file: ${dangerousFiles.join(", ")}`);
  }

  if (hasSuspiciousFileName) {
    score += 2;
    reasons.push("download name looks like a patch or hotfix");
  }

  if (baitMatches.length > 0) {
    score += Math.min(3, baitMatches.length);
    reasons.push("comment uses patch/fix bait language");
  }

  if (normalizedBody.length > 0 && normalizedBody.length < 700) {
    score += 1;
    reasons.push("short drive-by comment");
  }

  const spam =
    !trustedAuthor &&
    !botAuthor &&
    dangerousFiles.length > 0 &&
    score >= 6 &&
    (baitMatches.length >= 2 || (hasSuspiciousFileName && baitMatches.length >= 1));

  return {
    spam,
    score,
    reasons: spam ? reasons : [],
    dangerousFiles,
    trustedAuthor,
    botAuthor,
  };
}

module.exports = {
  detectSpamComment,
  extractDangerousFiles,
  isTrustedAuthor,
};
