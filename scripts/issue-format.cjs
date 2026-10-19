function countSummaryUnits(text) {
  return [...String(text || '')].length;
}

/**
 * Title rules for the issue format check.
 * Accepts [Bug]/[Feature]/[Other] with optional space after the bracket prefix.
 * Summary must be at least 4 code points (covers short CJK titles like #2449).
 * Legacy app titles `Bug: ...` remain valid with the same summary floor.
 */
function isValidIssueTitle(title) {
  const t = String(title || '').trim();
  if (!t) return false;
  const modern = t.match(/^\[(Bug|Feature|Other)\]\s*(.+)$/i);
  if (modern) {
    return countSummaryUnits(modern[2].trim()) >= 4;
  }
  const legacy = t.match(/^Bug:\s*(.+)$/i);
  if (legacy) {
    return countSummaryUnits(legacy[1].trim()) >= 4;
  }
  return false;
}

const ISSUE_TEMPLATE_MARKERS = Object.freeze([
  'Steps to reproduce',
  'Expected behavior',
  'Actual behavior',
  'Describe the problem',
  'Problem / pain point',
  'Proposed solution',
  'Operating system',
  'Topic / question',
]);

/**
 * Format errors used by issue-format.yml.
 * @returns {string[]} empty when the issue passes format checks
 */
function getIssueFormatErrors(issue) {
  const errors = [];
  const title = String(issue?.title || '').trim();
  const body = String(issue?.body || '').trim();

  if (!isValidIssueTitle(title)) {
    errors.push(
      'Title must start with `[Bug]` or `[Feature]` (or `[Other]`) followed by a short summary (at least 4 characters after the prefix). Legacy app links using `Bug: ...` are also accepted. Example: `[Bug] SFTP upload fails on Windows`',
    );
  }

  if (body.length < 120) {
    errors.push(
      'Body is too short. Please use the Bug Report or Feature Request template and fill in all required fields.',
    );
  }

  const hasTemplateStructure = ISSUE_TEMPLATE_MARKERS.some((marker) =>
    body.includes(marker),
  );
  if (!hasTemplateStructure) {
    errors.push(
      'Body does not look like it came from an issue template. Choose **Bug Report** or **Feature Request** when opening an issue.',
    );
  }

  return errors;
}

/**
 * Format recovery when the issue is now valid but still carries invalid-format.
 * Clear the label; reopen only if still closed.
 *
 * @returns {{ recover: boolean, reopen: boolean }}
 */
function shouldRecoverIssueFormat({ state, labels = [], formatOk }) {
  if (!formatOk) return { recover: false, reopen: false };
  const names = new Set(
    (labels || []).map((label) =>
      typeof label === 'string' ? label : label?.name,
    ),
  );
  if (!names.has('invalid-format')) {
    return { recover: false, reopen: false };
  }
  return {
    recover: true,
    reopen: String(state || '').toLowerCase() === 'closed',
  };
}

module.exports = { isValidIssueTitle, getIssueFormatErrors, shouldRecoverIssueFormat };
