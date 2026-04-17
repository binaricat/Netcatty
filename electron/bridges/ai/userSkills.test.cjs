const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { buildUserSkillsContext, scanUserSkills } = require("./userSkills.cjs");

async function withUserSkills(skillDefinitions, run) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "netcatty-user-skills-"));
  const userDataDir = path.join(rootDir, "userData");
  const skillsDir = path.join(userDataDir, "Skills");
  await fs.mkdir(skillsDir, { recursive: true });

  for (const skill of skillDefinitions) {
    const skillDir = path.join(skillsDir, skill.directoryName);
    await fs.mkdir(skillDir, { recursive: true });
    const content = [
      "---",
      `name: ${skill.name}`,
      `description: ${skill.description}`,
      "---",
      "",
      skill.body,
      "",
    ].join("\n");
    await fs.writeFile(path.join(skillDir, "SKILL.md"), content, "utf8");
  }

  const electronApp = {
    getPath(key) {
      return key === "userData" ? userDataDir : "";
    },
  };

  try {
    await run(electronApp);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

test("does not auto-match a user skill from an absolute path segment", async () => {
  await withUserSkills(
    [
      {
        directoryName: "Tmp Helper",
        name: "tmp",
        description: "Helper for scratch space workflows.",
        body: "Body for tmp",
      },
    ],
    async (electronApp) => {
      const result = await buildUserSkillsContext(
        electronApp,
        "please inspect /tmp/netcatty.log",
        [],
      );

      assert.equal(result.context.includes("Matched user-managed skills for this request:"), false);
      assert.equal(result.context.includes("Body for tmp"), false);
    },
  );
});

test("keeps every explicitly selected skill in the built context", async () => {
  await withUserSkills(
    [
      {
        directoryName: "Alpha One",
        name: "Alpha One",
        description: "Alpha helper.",
        body: "Body for Alpha One",
      },
      {
        directoryName: "Beta Two",
        name: "Beta Two",
        description: "Beta helper.",
        body: "Body for Beta Two",
      },
      {
        directoryName: "Gamma Three",
        name: "Gamma Three",
        description: "Gamma helper.",
        body: "Body for Gamma Three",
      },
    ],
    async (electronApp) => {
      const result = await buildUserSkillsContext(
        electronApp,
        "plain prompt",
        ["alpha-one", "beta-two", "gamma-three"],
      );

      assert.equal(result.context.includes("Body for Alpha One"), true);
      assert.equal(result.context.includes("Body for Beta Two"), true);
      assert.equal(result.context.includes("Body for Gamma Three"), true);
    },
  );
});

test("uses longer skill descriptions for routing matches without injecting the full index text", async () => {
  const longDescription = [
    "Use when the user needs a detailed workflow for operating Netcatty through ACP skills and CLI.",
    "Includes platform launcher guidance, scoped command execution, recovery behavior, and constraints.",
    "This intentionally exceeds the older short description budget so routing has enough signal.",
    "It also names edge cases such as unavailable optional shells, strict chat-session scoping, and fallback-only history replay so the agent can choose the skill without reading the whole body first.",
  ].join(" ");

  assert.ok(longDescription.length > 320);

  await withUserSkills(
    [
      {
        directoryName: "Detailed Router",
        name: "Detailed Router",
        description: longDescription,
        body: "Detailed router body",
      },
    ],
    async (electronApp) => {
      const status = await scanUserSkills(electronApp);
      const result = await buildUserSkillsContext(
        electronApp,
        "Need fallback-only history replay guidance for ACP recovery.",
        [],
      );

      assert.equal(status.readyCount, 1);
      assert.equal(status.warningCount, 0);
      assert.equal(result.context.includes("### Detailed Router"), true);
      assert.equal(result.context.includes("Detailed router body"), true);
      assert.equal(result.context.includes(longDescription), false);
    },
  );
});

test("caps the injected available-skills index when descriptions are very long", async () => {
  const longDescription = "signal ".repeat(65);

  await withUserSkills(
    Array.from({ length: 8 }, (_, index) => ({
      directoryName: `Skill ${index + 1}`,
      name: `Skill ${index + 1}`,
      description: `${longDescription}${index + 1}`,
      body: `Body ${index + 1}`,
    })),
    async (electronApp) => {
      const result = await buildUserSkillsContext(
        electronApp,
        "plain prompt",
        [],
      );

      const availableLine = result.context
        .split("\n")
        .find((line) => line.startsWith("Available user skills: "));

      assert.ok(availableLine, "expected available-skills index line");
      assert.ok(availableLine.length < 1800, `expected capped index line, got ${availableLine.length}`);
    },
  );
});

test("preserves an unavailable explicit selection in the built context", async () => {
  await withUserSkills(
    [
      {
        directoryName: "Beta",
        name: "Beta",
        description: "Beta helper.",
        body: "Body for Beta",
      },
    ],
    async (electronApp) => {
      const result = await buildUserSkillsContext(
        electronApp,
        "plain prompt",
        ["missing-skill"],
      );

      assert.equal(result.context.includes("Available user skills: Beta: Beta helper."), true);
      assert.equal(result.context.includes("/missing-skill"), true);
      assert.match(result.context, /explicitly selected/i);
      assert.match(result.context, /unavailable/i);
    },
  );
});

test("initializing an empty skills directory creates only an instructions file", async () => {
  await withUserSkills([], async (electronApp) => {
    const status = await scanUserSkills(electronApp);
    const entries = await fs.readdir(status.directoryPath);

    assert.deepEqual(status.skills, []);
    assert.equal(status.readyCount, 0);
    assert.equal(status.warningCount, 0);
    assert.deepEqual(entries.sort(), ["README.txt"]);
  });
});

test("unreadable SKILL.md becomes a warning instead of aborting the entire scan", async () => {
  await withUserSkills(
    [
      {
        directoryName: "Working Skill",
        name: "Working Skill",
        description: "A valid skill.",
        body: "Working body",
      },
      {
        directoryName: "Broken Skill",
        name: "Broken Skill",
        description: "This file will be unreadable.",
        body: "Broken body",
      },
    ],
    async (electronApp) => {
      const unreadablePath = path.join(
        electronApp.getPath("userData"),
        "Skills",
        "Broken Skill",
        "SKILL.md",
      );

      await fs.chmod(unreadablePath, 0o000);

      try {
        const status = await scanUserSkills(electronApp);
        const workingSkill = status.skills.find((skill) => skill.name === "Working Skill");
        const brokenSkill = status.skills.find((skill) => skill.directoryName === "Broken Skill");

        assert.equal(status.readyCount, 1);
        assert.equal(status.warningCount, 1);
        assert.equal(workingSkill?.status, "ready");
        assert.equal(brokenSkill?.status, "warning");
        assert.match(brokenSkill?.warnings?.[0] || "", /Failed to read SKILL\.md/i);
      } finally {
        await fs.chmod(unreadablePath, 0o644);
      }
    },
  );
});

test("symlinked SKILL.md is downgraded to a warning and never injected", async () => {
  await withUserSkills(
    [
      {
        directoryName: "Working Skill",
        name: "Working Skill",
        description: "A valid skill.",
        body: "Working body",
      },
    ],
    async (electronApp) => {
      const skillsDir = path.join(electronApp.getPath("userData"), "Skills");
      const linkedDir = path.join(skillsDir, "Linked Skill");
      const externalTarget = path.join(skillsDir, "..", "outside-secret.md");
      await fs.mkdir(linkedDir, { recursive: true });
      await fs.writeFile(
        externalTarget,
        [
          "---",
          "name: Linked Skill",
          "description: Linked helper.",
          "---",
          "",
          "TOPSECRET",
          "",
        ].join("\n"),
        "utf8",
      );
      await fs.symlink(externalTarget, path.join(linkedDir, "SKILL.md"));

      const status = await scanUserSkills(electronApp);
      const result = await buildUserSkillsContext(electronApp, "plain prompt", ["linked-skill"]);
      const linkedSkill = status.skills.find((skill) => skill.directoryName === "Linked Skill");

      assert.equal(status.readyCount, 1);
      assert.equal(status.warningCount, 1);
      assert.equal(linkedSkill?.status, "warning");
      assert.match(linkedSkill?.warnings?.[0] || "", /symbolic link/i);
      assert.equal(result.context.includes("TOPSECRET"), false);
      assert.match(result.context, /linked-skill/i);
      assert.match(result.context, /unavailable/i);
    },
  );
});

test("duplicate normalized slugs are downgraded to warnings and not injected explicitly", async () => {
  await withUserSkills(
    [
      {
        directoryName: "Foo Bar",
        name: "Foo Bar",
        description: "First skill.",
        body: "Body for Foo Bar",
      },
      {
        directoryName: "foo-bar",
        name: "foo-bar",
        description: "Second skill.",
        body: "Body for foo-bar",
      },
    ],
    async (electronApp) => {
      const status = await scanUserSkills(electronApp);
      const result = await buildUserSkillsContext(electronApp, "plain prompt", ["foo-bar"]);

      assert.equal(status.readyCount, 0);
      assert.equal(status.warningCount, 2);
      assert.equal(status.skills.every((skill) => skill.status === "warning"), true);
      assert.equal(
        status.skills.every((skill) =>
          skill.warnings.some((warning) => warning.includes('Duplicate skill slug "foo-bar"')),
        ),
        true,
      );
      assert.equal(result.context.includes("Body for Foo Bar"), false);
      assert.equal(result.context.includes("Body for foo-bar"), false);
    },
  );
});

test("skills without a usable ASCII slug are downgraded to warnings", async () => {
  await withUserSkills(
    [
      {
        directoryName: "部署助手",
        name: "部署助手",
        description: "Deployment helper.",
        body: "Body for 部署助手",
      },
    ],
    async (electronApp) => {
      const status = await scanUserSkills(electronApp);

      assert.equal(status.readyCount, 0);
      assert.equal(status.warningCount, 1);
      assert.equal(status.skills[0]?.status, "warning");
      assert.equal(status.skills[0]?.slug, "");
      assert.match(
        status.skills[0]?.warnings?.[0] || "",
        /usable slug/i,
      );
    },
  );
});

test("explicit selections are capped to stay within the prompt budget", async () => {
  await withUserSkills(
    [
      {
        directoryName: "Skill One",
        name: "Skill One",
        description: "Helper one.",
        body: "BODY_ONE_" + "a".repeat(3500),
      },
      {
        directoryName: "Skill Two",
        name: "Skill Two",
        description: "Helper two.",
        body: "BODY_TWO_" + "b".repeat(3500),
      },
      {
        directoryName: "Skill Three",
        name: "Skill Three",
        description: "Helper three.",
        body: "BODY_THREE_" + "c".repeat(3500),
      },
      {
        directoryName: "Skill Four",
        name: "Skill Four",
        description: "Helper four.",
        body: "BODY_FOUR_" + "d".repeat(3500),
      },
      {
        directoryName: "Skill Five",
        name: "Skill Five",
        description: "Helper five.",
        body: "BODY_FIVE_" + "e".repeat(3500),
      },
    ],
    async (electronApp) => {
      const result = await buildUserSkillsContext(
        electronApp,
        "plain prompt",
        ["skill-one", "skill-two", "skill-three", "skill-four", "skill-five"],
      );

      assert.equal(result.context.includes("BODY_ONE_"), true);
      assert.equal(result.context.includes("BODY_TWO_"), true);
      assert.equal(result.context.includes("BODY_THREE_"), true);
      assert.equal(result.context.includes("BODY_FOUR_"), false);
      assert.equal(result.context.includes("BODY_FIVE_"), false);
      assert.match(result.context, /prompt budget|additional selected/i);
    },
  );
});
