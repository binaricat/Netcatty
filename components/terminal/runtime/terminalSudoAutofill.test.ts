import test from "node:test";
import assert from "node:assert/strict";
import {
  createSudoPasswordAutofill,
  getSingleBracketedPasteLine,
  isSudoPasswordPrompt,
  shouldArmSudoPasswordAutofill,
} from "./terminalSudoAutofill";

// --- isSudoPasswordPrompt ---

test("isSudoPasswordPrompt detects the standard sudo password prompt", () => {
  assert.equal(isSudoPasswordPrompt("[sudo] password for alice: "), true);
});

test("isSudoPasswordPrompt detects a bare Password prompt", () => {
  assert.equal(isSudoPasswordPrompt("Password: "), true);
});

test("isSudoPasswordPrompt detects localized sudo prompts", () => {
  assert.equal(isSudoPasswordPrompt("[sudo] alice 的密码："), true);
  assert.equal(isSudoPasswordPrompt("密码："), true);
});

test("isSudoPasswordPrompt rejects sub-command password prompts", () => {
  // sudo runs these; if sudo creds are cached it stays silent and the child
  // asks for its OWN password. Filling the sudo password here would leak it.
  assert.equal(isSudoPasswordPrompt("Enter password: "), false); // mysql -p
  assert.equal(isSudoPasswordPrompt("alice@host's password: "), false); // ssh
  assert.equal(isSudoPasswordPrompt("MySQL root password: "), false);
  assert.equal(isSudoPasswordPrompt("Password for user alice: "), false); // psql/libpq
  assert.equal(isSudoPasswordPrompt("password for alice: "), false); // no [sudo] tag
});

test("isSudoPasswordPrompt detects color-wrapped prompts", () => {
  assert.equal(isSudoPasswordPrompt("\x1b[32m[sudo] password for alice: \x1b[0m"), true);
});

test("isSudoPasswordPrompt ignores ordinary output mentioning password", () => {
  assert.equal(isSudoPasswordPrompt("try sudo if the password is required\n"), false);
  assert.equal(isSudoPasswordPrompt("the password was changed\n"), false);
  assert.equal(isSudoPasswordPrompt("sudo: command not found\n"), false);
});

test("isSudoPasswordPrompt refuses concealed prompt text", () => {
  assert.equal(isSudoPasswordPrompt("\x1b[8m[sudo] password for alice: \x1b[0m"), false);
});

test("isSudoPasswordPrompt detects the Ubuntu PAM-style prompt from #1281", () => {
  // The trailing bare "Password:" is what PAM emits on Ubuntu; the leading
  // "[sudo: ...]" wrapper was an artifact of the old -p injection.
  assert.equal(isSudoPasswordPrompt("[sudo: [sudo] password for alice: ] Password: "), true);
  assert.equal(isSudoPasswordPrompt("Password:"), true);
});

// --- arming + autofill ---

test("sudo autofill ignores sudo-looking output until a sudo command is submitted", () => {
  const writes: string[] = [];
  const autofill = createSudoPasswordAutofill({
    password: "secret",
    write: (data) => writes.push(data),
  });

  autofill.handleOutput("[sudo] password for alice: ");

  assert.deepEqual(writes, []);
});

test("sudo autofill sends the password once after a submitted sudo command", () => {
  const writes: string[] = [];
  let now = 1_000;
  const autofill = createSudoPasswordAutofill({
    password: "secret",
    now: () => now,
    write: (data) => writes.push(data),
  });

  autofill.armForCommand("sudo -i");
  autofill.handleOutput("[sudo] password for alice: ");
  now += 500;
  autofill.handleOutput("[sudo] password for alice: ");

  assert.deepEqual(writes, ["secret\n"]);
});

test("sudo autofill fills a bare Password prompt within the arm window", () => {
  const writes: string[] = [];
  const autofill = createSudoPasswordAutofill({
    password: "secret",
    write: (data) => writes.push(data),
  });

  autofill.armForCommand("sudo apt update");
  autofill.handleOutput("Password: ");

  assert.deepEqual(writes, ["secret\n"]);
});

test("sudo autofill fills the Ubuntu PAM-style prompt from #1281", () => {
  const writes: string[] = [];
  const autofill = createSudoPasswordAutofill({
    password: "secret",
    write: (data) => writes.push(data),
  });

  autofill.armForCommand("sudo -i");
  autofill.handleOutput("[sudo: [sudo] password for alice: ] Password: ");

  assert.deepEqual(writes, ["secret\n"]);
});

test("sudo autofill does not leak the password to sub-command prompts", () => {
  const writes: string[] = [];
  const autofill = createSudoPasswordAutofill({
    password: "secret",
    write: (data) => writes.push(data),
  });

  // sudo creds warm: sudo stays silent, mysql asks for its own password.
  autofill.armForCommand("sudo mysql -p");
  autofill.handleOutput("Enter password: ");
  assert.deepEqual(writes, []);

  autofill.armForCommand("sudo ssh user@host");
  autofill.handleOutput("user@host's password: ");
  assert.deepEqual(writes, []);

  autofill.armForCommand("sudo psql -h db -U alice");
  autofill.handleOutput("Password for user alice: ");
  assert.deepEqual(writes, []);
});

test("sudo autofill disarms when a later non-sudo command is submitted", () => {
  const writes: string[] = [];
  const autofill = createSudoPasswordAutofill({
    password: "secret",
    write: (data) => writes.push(data),
  });

  // sudo did not prompt (cached creds / noninteractive); a later non-sudo
  // command must clear the pending arm so its own Password: isn't filled.
  autofill.armForCommand("sudo -n true");
  autofill.armForCommand("mysql -p");
  autofill.handleOutput("Password: ");

  assert.deepEqual(writes, []);
});

test("sudo autofill keeps the prompt text in the output while filling", () => {
  const writes: string[] = [];
  const autofill = createSudoPasswordAutofill({
    password: "secret",
    write: (data) => writes.push(data),
  });

  autofill.armForCommand("sudo whoami");

  assert.equal(
    autofill.handleOutput("[sudo] password for alice: "),
    "[sudo] password for alice: ",
  );
  assert.deepEqual(writes, ["secret\n"]);
});

test("sudo autofill passes ordinary output through unchanged without filling", () => {
  const writes: string[] = [];
  const autofill = createSudoPasswordAutofill({
    password: "secret",
    write: (data) => writes.push(data),
  });

  autofill.armForCommand("sudo apt update");

  assert.equal(autofill.handleOutput("Reading package lists...\r\n"), "Reading package lists...\r\n");
  assert.deepEqual(writes, []);
});

test("sudo autofill handles prompts split across chunks", () => {
  const writes: string[] = [];
  const autofill = createSudoPasswordAutofill({
    password: "secret",
    write: (data) => writes.push(data),
  });

  autofill.armForCommand("sudo apt update");
  autofill.handleOutput("[sudo] password ");
  autofill.handleOutput("for alice: ");

  assert.deepEqual(writes, ["secret\n"]);
});

test("sudo autofill stays armed through ordinary output before the prompt", () => {
  const writes: string[] = [];
  const autofill = createSudoPasswordAutofill({
    password: "secret",
    write: (data) => writes.push(data),
  });

  autofill.armForCommand("sudo whoami");
  autofill.handleOutput("sudo: a first-time notice\r\n");
  autofill.handleOutput("[sudo] password for alice: ");

  assert.deepEqual(writes, ["secret\n"]);
});

test("sudo autofill fills again for a second sudo command", () => {
  const writes: string[] = [];
  let now = 1_000;
  const autofill = createSudoPasswordAutofill({
    password: "secret",
    now: () => now,
    write: (data) => writes.push(data),
  });

  autofill.armForCommand("sudo first");
  autofill.handleOutput("[sudo] password for alice: ");
  now += 1_000;
  autofill.armForCommand("sudo second");
  autofill.handleOutput("[sudo] password for alice: ");

  assert.deepEqual(writes, ["secret\n", "secret\n"]);
});

test("sudo autofill ignores expired sudo command arms", () => {
  const writes: string[] = [];
  let now = 1_000;
  const autofill = createSudoPasswordAutofill({
    password: "secret",
    now: () => now,
    write: (data) => writes.push(data),
  });

  autofill.armForCommand("sudo whoami");
  now += 31_000;
  autofill.handleOutput("[sudo] password for alice: ");

  assert.deepEqual(writes, []);
});

test("sudo autofill does not arm for non-sudo commands", () => {
  const writes: string[] = [];
  const autofill = createSudoPasswordAutofill({
    password: "secret",
    write: (data) => writes.push(data),
  });

  autofill.armForCommand("echo '[sudo] password for alice:'");
  autofill.handleOutput("[sudo] password for alice: ");

  assert.deepEqual(writes, []);
});

test("sudo autofill does nothing without a saved password", () => {
  const writes: string[] = [];
  const autofill = createSudoPasswordAutofill({
    password: "",
    write: (data) => writes.push(data),
  });

  autofill.armForCommand("sudo whoami");
  autofill.handleOutput("[sudo] password for alice: ");

  assert.deepEqual(writes, []);
});

test("getSingleBracketedPasteLine extracts single-line bracketed paste content", () => {
  assert.equal(getSingleBracketedPasteLine("\x1b[200~sudo whoami\x1b[201~"), "sudo whoami");
  assert.equal(getSingleBracketedPasteLine("\x1b[200~sudo whoami\rpwd\x1b[201~"), null);
});

test("shouldArmSudoPasswordAutofill only arms direct sudo commands", () => {
  assert.equal(shouldArmSudoPasswordAutofill("sudo whoami"), true);
  assert.equal(shouldArmSudoPasswordAutofill("command sudo whoami"), true);
  assert.equal(shouldArmSudoPasswordAutofill("builtin sudo whoami"), true);
  assert.equal(shouldArmSudoPasswordAutofill("echo '[sudo] password for alice:'"), false);
  assert.equal(shouldArmSudoPasswordAutofill("cat sudo.log"), false);
});
