const fsPromises = require("node:fs/promises");
const path = require("node:path");

const USER_SKILLS_DIR_NAME = "Skills";
const USER_SKILLS_README_NAME = "README.txt";
const MAX_SKILL_BYTES = 24 * 1024;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_INDEX_SKILLS = 8;
const MAX_INDEX_DESCRIPTION_CHARS = 160;
const MAX_INDEX_LINE_CHARS = 1400;
const MAX_EXPLICIT_SKILLS = 4;
const MAX_MATCHED_SKILLS = 2;
const MAX_MATCHED_SKILL_CHARS = 6000;
const MAX_TOTAL_INJECTED_SKILL_CHARS = 12000;
const USER_SKILLS_README_CONTENT = [
  "Netcatty user skills",
  "",
  "Add one folder per skill inside this directory.",
  "Each skill folder must contain a SKILL.md file.",
  "",
  "Example layout:",
  "  Skills/",
  "    My Skill/",
  "      SKILL.md",
  "",
  "Minimal SKILL.md:",
  "  ---",
  "  name: My Skill",
  "  description: Short summary of what this skill helps with.",
  "  ---",
  "",
  "  Write the skill instructions here.",
  "",
  "After adding or editing a skill, reopen the AI settings page or start a new chat to refresh the list.",
  "",
].join("\n");

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "when", "then",
  "only", "your", "will", "should", "have", "has", "had", "using", "use",
  "agent", "skill", "skills", "task", "file", "files", "user", "into", "about",
]);

function stripQuotes(value) {
  const trimmed = String(value || "").trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function slugifySkill(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncateInlineText(value, maxChars) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function formatSkillReadWarning(error) {
  const code = typeof error?.code === "string" ? error.code : null;
  const message = typeof error?.message === "string" ? error.message : String(error || "Unknown error");
  return code
    ? `Failed to read SKILL.md (${code}: ${message}).`
    : `Failed to read SKILL.md (${message}).`;
}

function containsPlaintextPhrase(prompt, phrase) {
  const trimmedPhrase = String(phrase || "").trim();
  if (!trimmedPhrase) return false;
  const pattern = new RegExp(`(^|\\s)${escapeRegExp(trimmedPhrase)}(?=$|\\s|[.,!?;:])`, "i");
  return pattern.test(String(prompt || ""));
}

function parseFrontmatter(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) {
    return { attributes: {}, body: content, hasFrontmatter: false };
  }

  const attributes = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const colonIndex = line.indexOf(":");
    if (colonIndex <= 0) continue;
    const key = line.slice(0, colonIndex).trim();
    const value = stripQuotes(line.slice(colonIndex + 1).trim());
    if (key) attributes[key] = value;
  }

  return {
    attributes,
    body: content.slice(match[0].length),
    hasFrontmatter: true,
  };
}

function summarizeSkillSlugs(skillsOrSlugs, maxItems = 4) {
  const values = (Array.isArray(skillsOrSlugs) ? skillsOrSlugs : [])
    .map((entry) => {
      if (typeof entry === "string") return entry;
      const slug = typeof entry?.slug === "string" ? entry.slug : "";
      return slug;
    })
    .filter(Boolean)
    .map((slug) => `/${slug}`);
  if (values.length <= maxItems) {
    return values.join(", ");
  }
  return `${values.slice(0, maxItems).join(", ")}, and ${values.length - maxItems} more`;
}

function getUserSkillsDir(electronApp) {
  const userDataDir = electronApp?.getPath?.("userData");
  if (!userDataDir) {
    throw new Error("Electron app userData path is unavailable.");
  }
  return path.join(userDataDir, USER_SKILLS_DIR_NAME);
}

async function ensureUserSkillsDir(electronApp) {
  const skillsDir = getUserSkillsDir(electronApp);
  await fsPromises.mkdir(skillsDir, { recursive: true });
  return skillsDir;
}

async function ensureUserSkillsReadme(electronApp) {
  const skillsDir = await ensureUserSkillsDir(electronApp);
  const dirEntries = await fsPromises.readdir(skillsDir);
  if (dirEntries.length === 0) {
    await fsPromises.writeFile(
      path.join(skillsDir, USER_SKILLS_README_NAME),
      USER_SKILLS_README_CONTENT,
      "utf8",
    );
  }
  return skillsDir;
}

async function scanUserSkills(electronApp) {
  const skillsDir = await ensureUserSkillsReadme(electronApp);
  const dirEntries = await fsPromises.readdir(skillsDir, { withFileTypes: true });
  const skills = [];
  const warnings = [];

  for (const entry of dirEntries) {
    // Only process actual directories, skipping symlinks for security
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;

    const dirName = entry.name;
    // Basic path traversal protection: skip any directory name containing path separators
    if (dirName.includes("/") || dirName.includes("\\") || dirName === ".." || dirName === ".") {
      continue;
    }

    const skillDir = path.join(skillsDir, dirName);
    const skillPath = path.join(skillDir, "SKILL.md");
    const baseItem = {
      id: dirName,
      slug: slugifySkill(dirName),
      directoryName: dirName,
      directoryPath: skillDir,
      skillPath,
      name: dirName,
      description: "",
      status: "warning",
      warnings: [],
    };

    try {
      await fsPromises.access(skillPath);
    } catch {
      baseItem.warnings.push("Missing SKILL.md");
      warnings.push(`${dirName}: Missing SKILL.md`);
      skills.push(baseItem);
      continue;
    }

    try {
      const stat = await fsPromises.lstat(skillPath);
      if (stat.isSymbolicLink()) {
        baseItem.warnings.push("SKILL.md must not be a symbolic link.");
        warnings.push(`${dirName}: SKILL.md must not be a symbolic link.`);
        skills.push(baseItem);
        continue;
      }

      if (!stat.isFile()) {
        baseItem.warnings.push("SKILL.md must be a regular file.");
        warnings.push(`${dirName}: SKILL.md must be a regular file.`);
        skills.push(baseItem);
        continue;
      }

      if (stat.size > MAX_SKILL_BYTES) {
        baseItem.warnings.push(`SKILL.md is too large (${stat.size} bytes > ${MAX_SKILL_BYTES} bytes).`);
        warnings.push(`${dirName}: SKILL.md is too large.`);
        skills.push(baseItem);
        continue;
      }

      const content = await fsPromises.readFile(skillPath, "utf8");
      const { attributes, body, hasFrontmatter } = parseFrontmatter(content);
      const name = stripQuotes(attributes.name || "").trim();
      const description = stripQuotes(attributes.description || "").trim();
      const usableSlug = slugifySkill(name || dirName);

      if (!hasFrontmatter) {
        baseItem.warnings.push("Missing YAML frontmatter.");
      }
      if (!name) {
        baseItem.warnings.push("Missing frontmatter field: name.");
      }
      if (!description) {
        baseItem.warnings.push("Missing frontmatter field: description.");
      } else if (description.length > MAX_DESCRIPTION_LENGTH) {
        baseItem.warnings.push(`Description is too long (${description.length} chars > ${MAX_DESCRIPTION_LENGTH}).`);
      }
      if (!usableSlug) {
        baseItem.warnings.push("Skill name must include ASCII letters or digits to generate a usable slug.");
      }

      if (baseItem.warnings.length > 0) {
        warnings.push(...baseItem.warnings.map((warning) => `${dirName}: ${warning}`));
        skills.push({
          ...baseItem,
          slug: usableSlug,
          name: name || dirName,
          description,
        });
        continue;
      }

      skills.push({
        ...baseItem,
        slug: usableSlug,
        name,
        description,
        status: "ready",
        warnings: [],
        body,
        mtimeMs: stat.mtimeMs,
      });
    } catch (error) {
      const warning = formatSkillReadWarning(error);
      baseItem.warnings.push(warning);
      warnings.push(`${dirName}: ${warning}`);
      skills.push(baseItem);
    }
  }

  const readySkillsBySlug = new Map();
  for (const skill of skills) {
    if (skill.status !== "ready" || !skill.slug) continue;
    const matches = readySkillsBySlug.get(skill.slug);
    if (matches) {
      matches.push(skill);
    } else {
      readySkillsBySlug.set(skill.slug, [skill]);
    }
  }

  for (const [slug, duplicateSkills] of readySkillsBySlug.entries()) {
    if (duplicateSkills.length < 2) continue;
    const duplicateWarning = `Duplicate skill slug "${slug}". Rename the skill or change its frontmatter name.`;
    for (const skill of duplicateSkills) {
      skill.status = "warning";
      skill.warnings = [...skill.warnings, duplicateWarning];
      warnings.push(`${skill.directoryName}: ${duplicateWarning}`);
    }
  }

  const readyCount = skills.filter((skill) => skill.status === "ready").length;
  const warningCount = skills.filter((skill) => skill.status === "warning").length;

  return {
    directoryPath: skillsDir,
    readyCount,
    warningCount,
    skills: skills.map((skill) => ({
      id: skill.id,
      slug: skill.slug,
      directoryName: skill.directoryName,
      directoryPath: skill.directoryPath,
      skillPath: skill.skillPath,
      name: skill.name,
      description: skill.description,
      status: skill.status,
      warnings: skill.warnings,
    })),
    warnings,
    _readySkills: skills.filter((skill) => skill.status === "ready"),
  };
}

/**
 * Scores how well a skill matches a user prompt.
 *
 * Scored based on:
 * - 50 points: Plain-text name/directory mention (e.g. prompt contains "my skill")
 * - 1 point per keyword overlap (after tokenization/stopword filtering)
 *
 * @param {string} prompt - The user prompt
 * @param {object} skill - The skill object from scanUserSkills
 * @returns {number} The score (higher is better)
 */
function scoreSkillMatch(prompt, skill) {
  const name = String(skill.name || "").trim();
  const directoryName = String(skill.directoryName || "").trim();

  // High weight for an exact plain-text mention of the skill name.
  if (
    (name && containsPlaintextPhrase(prompt, name)) ||
    (directoryName && containsPlaintextPhrase(prompt, directoryName))
  ) {
    return 50;
  }

  // Fallback to token keyword overlap
  const promptTokens = new Set(tokenize(prompt));
  const skillTokens = tokenize(`${skill.name} ${skill.description}`);
  let overlap = 0;
  for (const token of skillTokens) {
    if (promptTokens.has(token)) overlap += 1;
  }
  return overlap;
}

/**
 * Builds the contextual prompt part from matched user skills.
 *
 * @param {object} electronApp - The Electron app instance
 * @param {string} prompt - The user's input prompt
 * @param {string[]} selectedSkillSlugs - Explicitly requested skill slugs
 * @returns {Promise<{context: string, status: object}>} The built prompt part and scan status
 */
async function buildUserSkillsContext(electronApp, prompt, selectedSkillSlugs = []) {
  const status = await scanUserSkills(electronApp);
  const readySkills = status._readySkills || [];
  const trimmedPrompt = String(prompt || "").trim();
  if (readySkills.length === 0) {
    return { context: "", status };
  }

  const indexSkills = readySkills.slice(0, MAX_INDEX_SKILLS);
  let remainingCount = Math.max(readySkills.length - indexSkills.length, 0);
  const indexEntries = [];
  let indexChars = 0;

  for (const skill of indexSkills) {
    const entry = `${skill.name}: ${truncateInlineText(skill.description, MAX_INDEX_DESCRIPTION_CHARS)}`;
    const separatorChars = indexEntries.length > 0 ? 2 : 0;
    if (indexChars + separatorChars + entry.length > MAX_INDEX_LINE_CHARS) {
      remainingCount += indexSkills.length - indexEntries.length;
      break;
    }
    indexEntries.push(entry);
    indexChars += separatorChars + entry.length;
  }

  const indexLine = indexEntries.join("; ");

  const orderedExplicitSlugs = [];
  const seenExplicitSlugs = new Set();
  for (const rawSlug of Array.isArray(selectedSkillSlugs) ? selectedSkillSlugs : []) {
    const slug = slugifySkill(rawSlug);
    if (!slug || seenExplicitSlugs.has(slug)) continue;
    seenExplicitSlugs.add(slug);
    orderedExplicitSlugs.push(slug);
  }

  const additionalExplicitCount = Math.max(orderedExplicitSlugs.length - MAX_EXPLICIT_SKILLS, 0);
  const cappedExplicitSlugs = orderedExplicitSlugs.slice(0, MAX_EXPLICIT_SKILLS);
  const explicitSlugSet = new Set(cappedExplicitSlugs);
  const readySkillsBySlug = new Map(readySkills.map((skill) => [skill.slug, skill]));
  const explicitSkills = [];
  const unavailableExplicitSlugs = [];
  for (const slug of cappedExplicitSlugs) {
    const skill = readySkillsBySlug.get(slug);
    if (skill) {
      explicitSkills.push(skill);
    } else {
      unavailableExplicitSlugs.push(slug);
    }
  }

  const matchedSkills = readySkills
    .filter((skill) => !explicitSlugSet.has(skill.slug))
    .map((skill) => ({ skill, score: scoreSkillMatch(trimmedPrompt, skill) }))
    .filter((entry) => entry.score >= 2)
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_MATCHED_SKILLS)
    .map((entry) => entry.skill);

  const finalSkills = [...explicitSkills, ...matchedSkills];

  const parts = [
    "User-managed skills are installed in Netcatty.",
    `Available user skills: ${indexLine}${remainingCount > 0 ? `; and ${remainingCount} more.` : "."}`,
    "Use a user-managed skill only when it clearly matches the current request.",
  ];

  if (additionalExplicitCount > 0) {
    parts.push(
      `The user selected ${additionalExplicitCount} additional Netcatty user skills that were omitted to stay within the prompt budget.`,
    );
  }

  if (unavailableExplicitSlugs.length > 0) {
    parts.push(
      `The user explicitly selected these Netcatty user skills for this request, but their content is currently unavailable: ${summarizeSkillSlugs(unavailableExplicitSlugs)}.`,
    );
  }

  if (finalSkills.length > 0) {
    const includedSkillSections = [];
    const omittedSkills = [];
    const truncatedSkills = [];
    let remainingSkillChars = MAX_TOTAL_INJECTED_SKILL_CHARS;
    let budgetStopIndex = finalSkills.length;

    for (let index = 0; index < finalSkills.length; index += 1) {
      const skill = finalSkills[index];
      const heading = `### ${skill.name}\n`;
      const maxBodyChars = Math.min(
        MAX_MATCHED_SKILL_CHARS,
        Math.max(remainingSkillChars - heading.length, 0),
      );
      if (maxBodyChars <= 0) {
        omittedSkills.push(skill);
        continue;
      }

      const rawBody = String(skill.body || "").trim();
      if (!rawBody) {
        omittedSkills.push(skill);
        continue;
      }

      if (rawBody.length > maxBodyChars && includedSkillSections.length > 0) {
        omittedSkills.push(skill);
        budgetStopIndex = index;
        continue;
      }

      const body = rawBody.slice(0, maxBodyChars);
      if (!body) {
        omittedSkills.push(skill);
        continue;
      }

      includedSkillSections.push(`${heading}${body}`);
      remainingSkillChars -= heading.length + body.length;

      if (body.length < rawBody.length) {
        truncatedSkills.push(skill);
        budgetStopIndex = index + 1;
        break;
      }
    }

    parts.push("Matched user-managed skills for this request:");

    if (includedSkillSections.length > 0) {
      parts.push(...includedSkillSections);
    }

    const omittedAfterIncluded = finalSkills.slice(budgetStopIndex);
    for (const skill of omittedAfterIncluded) {
      if (!omittedSkills.includes(skill) && !truncatedSkills.includes(skill)) {
        omittedSkills.push(skill);
      }
    }

    if (truncatedSkills.length > 0) {
      parts.push(
        `Some matched user-managed skill content was truncated to stay within the prompt budget: ${summarizeSkillSlugs(truncatedSkills)}.`,
      );
    }

    if (omittedSkills.length > 0) {
      parts.push(
        `Additional matched user-managed skills were omitted to stay within the prompt budget: ${summarizeSkillSlugs(omittedSkills)}.`,
      );
    }
  }

  return {
    context: parts.join("\n\n"),
    status,
  };
}

function toPublicUserSkillsStatus(status) {
  if (!status || typeof status !== "object") {
    return status;
  }
  const publicStatus = { ...status };
  delete publicStatus._readySkills;
  return publicStatus;
}

module.exports = {
  USER_SKILLS_DIR_NAME,
  getUserSkillsDir,
  ensureUserSkillsDir,
  ensureUserSkillsReadme,
  scanUserSkills,
  buildUserSkillsContext,
  toPublicUserSkillsStatus,
};
