import test from "node:test";
import assert from "node:assert/strict";
import {
  createSudoPasswordAutofill,
  getSingleBracketedPasteLine,
  isSudoPasswordPrompt,
  shouldArmSudoPasswordAutofill,
} from "./terminalSudoAutofill";

// --- isSudoPasswordPrompt: relaxed — any password/密码/口令 line ending in a
// colon. Over-matching is safe now because filling requires explicit confirm. ---

test("isSudoPasswordPrompt detects sudo and PAM prompts", () => {
  assert.equal(isSudoPasswordPrompt("[sudo] password for alice: "), true);
  assert.equal(isSudoPasswordPrompt("Password: "), true);
  assert.equal(isSudoPasswordPrompt("password for alice: "), true);
  assert.equal(isSudoPasswordPrompt("[sudo: [sudo] password for alice: ] Password: "), true);
});

test("isSudoPasswordPrompt detects localized prompts", () => {
  assert.equal(isSudoPasswordPrompt("[sudo] alice 的密码："), true);
  assert.equal(isSudoPasswordPrompt("密码："), true);
  assert.equal(isSudoPasswordPrompt("请输入密码: "), true);
});

test("isSudoPasswordPrompt detects color-wrapped prompts", () => {
  assert.equal(isSudoPasswordPrompt("\x1b[32m[sudo] password for alice: \x1b[0m"), true);
});

test("isSudoPasswordPrompt ignores ordinary output", () => {
  assert.equal(isSudoPasswordPrompt("try sudo if the password is required\n"), false);
  assert.equal(isSudoPasswordPrompt("the password was changed\n"), false);
  assert.equal(isSudoPasswordPrompt("sudo: command not found\n"), false);
});

test("isSudoPasswordPrompt refuses concealed prompt text", () => {
  assert.equal(isSudoPasswordPrompt("\x1b[8m[sudo] password for alice: \x1b[0m"), false);
});

// --- arm + hint (confirm-to-fill) ---

const make = (password = "secret") => {
  const writes: string[] = [];
  const hints: boolean[] = [];
  const autofill = createSudoPasswordAutofill({
    password,
    write: (d) => writes.push(d),
    onHint: (active) => {
      hints.push(active);
      return true; // hint overlay shown successfully
    },
  });
  return { autofill, writes, hints };
};

test("shows a hint (not a fill) when a sudo prompt appears", () => {
  const { autofill, writes, hints } = make();
  autofill.armForCommand("sudo whoami");
  assert.equal(
    autofill.handleOutput("[sudo] password for alice: "),
    "[sudo] password for alice: ",
  );
  assert.deepEqual(hints, [true]);
  assert.deepEqual(writes, []);
  assert.equal(autofill.isPromptPending(), true);
});

test("confirmFill writes the password and clears the hint", () => {
  const { autofill, writes, hints } = make();
  autofill.armForCommand("sudo whoami");
  autofill.handleOutput("[sudo] password for alice: ");
  autofill.confirmFill();
  assert.deepEqual(writes, ["secret\n"]);
  assert.deepEqual(hints, [true, false]);
  assert.equal(autofill.isPromptPending(), false);
});

test("cancelHint clears the hint without filling", () => {
  const { autofill, writes, hints } = make();
  autofill.armForCommand("sudo whoami");
  autofill.handleOutput("[sudo] password for alice: ");
  autofill.cancelHint();
  assert.deepEqual(writes, []);
  assert.deepEqual(hints, [true, false]);
  assert.equal(autofill.isPromptPending(), false);
});

test("confirmFill does nothing when no prompt is pending", () => {
  const { autofill, writes } = make();
  autofill.confirmFill();
  assert.deepEqual(writes, []);
});

test("does not arm when the hint cannot be shown (overlay unavailable)", () => {
  // If onHint reports the hint could not render (e.g. autocomplete disabled, no
  // ghost overlay), we must NOT leave a pending arm — otherwise Enter would
  // submit the sudo password with no visible confirmation.
  const writes: string[] = [];
  const autofill = createSudoPasswordAutofill({
    password: "secret",
    write: (d) => writes.push(d),
    onHint: () => false,
  });
  autofill.armForCommand("sudo whoami");
  autofill.handleOutput("[sudo] password for alice: ");
  assert.equal(autofill.isPromptPending(), false);
  autofill.confirmFill();
  assert.deepEqual(writes, []);
});

test("no hint until a sudo command is submitted", () => {
  const { autofill, hints } = make();
  autofill.handleOutput("[sudo] password for alice: ");
  assert.deepEqual(hints, []);
});

test("no hint without a saved password", () => {
  const { autofill, hints } = make("");
  autofill.armForCommand("sudo whoami");
  autofill.handleOutput("[sudo] password for alice: ");
  assert.deepEqual(hints, []);
});

test("hint fires once across chunked prompt output", () => {
  const { autofill, hints } = make();
  autofill.armForCommand("sudo apt update");
  autofill.handleOutput("[sudo] password ");
  autofill.handleOutput("for alice: ");
  assert.deepEqual(hints, [true]);
});

test("relaxed detection still only hints, never auto-fills child prompts", () => {
  // sudo creds warm -> mysql asks for its own password. We may hint, but we
  // must not send anything without an explicit confirm.
  const { autofill, hints, writes } = make();
  autofill.armForCommand("sudo mysql -p");
  autofill.handleOutput("Enter password: ");
  assert.deepEqual(hints, [true]);
  assert.deepEqual(writes, []);
});

test("a later non-sudo command disarms the pending hint", () => {
  const { autofill, writes, hints } = make();
  autofill.armForCommand("sudo -n true");
  autofill.handleOutput("Password: ");
  assert.deepEqual(hints, [true]);
  autofill.armForCommand("mysql -p"); // non-sudo command clears the arm
  assert.deepEqual(hints, [true, false]);
  autofill.confirmFill();
  assert.deepEqual(writes, []);
});

test("clears a pending hint when output moves past the prompt", () => {
  const { autofill, writes, hints } = make();
  autofill.armForCommand("sudo whoami");
  autofill.handleOutput("[sudo] password for alice: ");
  assert.equal(autofill.isPromptPending(), true);
  // user never pressed Enter; sudo times out and returns to the shell
  autofill.handleOutput("\r\nsudo: timed out reading password\r\nalice@host:~$ ");
  assert.equal(autofill.isPromptPending(), false);
  assert.deepEqual(hints, [true, false]); // hint was hidden
  autofill.confirmFill();
  assert.deepEqual(writes, []); // a later Enter no longer sends the password
});

test("keeps the hint pending when sudo re-prompts after a wrong password", () => {
  const { autofill, hints } = make();
  autofill.armForCommand("sudo whoami");
  autofill.handleOutput("[sudo] password for alice: ");
  autofill.handleOutput("\r\nSorry, try again.\r\n[sudo] password for alice: ");
  assert.equal(autofill.isPromptPending(), true);
  assert.deepEqual(hints, [true]);
});

test("an expired arm shows no hint", () => {
  const writes: string[] = [];
  const hints: boolean[] = [];
  let now = 1_000;
  const autofill = createSudoPasswordAutofill({
    password: "secret",
    now: () => now,
    write: (d) => writes.push(d),
    onHint: (a) => hints.push(a),
  });
  autofill.armForCommand("sudo whoami");
  now += 31_000;
  autofill.handleOutput("[sudo] password for alice: ");
  assert.deepEqual(hints, []);
});

test("handleOutput passes data through unchanged", () => {
  const { autofill } = make();
  autofill.armForCommand("sudo whoami");
  assert.equal(
    autofill.handleOutput("Reading package lists...\r\n"),
    "Reading package lists...\r\n",
  );
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
