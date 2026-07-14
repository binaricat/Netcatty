import test from "node:test";
import assert from "node:assert/strict";
import {
  createSudoPasswordAutofill,
  getSingleBracketedPasteLine,
  isExplicitSudoPrompt,
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

test("isSudoPasswordPrompt matches Kylin-style prompts without trailing colon", () => {
  // Kylin Professional: sudo prompt has no [sudo] tag and no trailing colon (#1293)
  assert.equal(isSudoPasswordPrompt("密码"), true);
  assert.equal(isSudoPasswordPrompt("用户 的密码"), true);
  assert.equal(isSudoPasswordPrompt("密码 "), true);
  // Exact prompts from issue #1293 screenshots (sudo -s on Kylin V10)
  assert.equal(isSudoPasswordPrompt("输入密码"), true);
  assert.equal(isSudoPasswordPrompt("Input Password"), true);
});

test("isExplicitSudoPrompt matches Kylin-style prompts", () => {
  // Kylin-style [sudo] prompt without trailing colon
  assert.equal(isExplicitSudoPrompt("[sudo] 密码"), true);
  assert.equal(isExplicitSudoPrompt("[sudo] password for alice"), true);
});

test("handleOutput hints on Kylin screenshot sudo prompts when armed", () => {
  const { autofill, hints, writes } = make();
  autofill.armForCommand("sudo -s");
  autofill.handleOutput("输入密码");
  assert.deepEqual(hints, [true]);
  assert.deepEqual(writes, []);
  assert.equal(autofill.isPromptPending(), true);

  const english = make();
  english.autofill.armForCommand("sudo -s");
  english.autofill.handleOutput("Input Password");
  assert.deepEqual(english.hints, [true]);
  assert.deepEqual(english.writes, []);
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

test("Esc soft-dismiss keeps arm so assist can re-open on the same Password prompt", () => {
  const writes: string[] = [];
  const pickerActives: boolean[] = [];
  const autofill = createSudoPasswordAutofill({
    mode: "picker",
    candidates: [
      { id: "host", label: "Host", password: "host-secret" },
      { id: "identity:root", label: "Root", password: "root-secret" },
    ],
    write: (d) => writes.push(d),
    onPicker: (active) => {
      pickerActives.push(active);
      return true;
    },
  });
  autofill.armForCommand("su root");
  autofill.handleOutput("Password: ");
  assert.equal(autofill.isPickerPending(), true);
  autofill.cancelHint();
  assert.equal(autofill.isPickerPending(), false);
  assert.equal(autofill.canReshowAssist(), true);
  // Same static prompt: more output without a new line must not auto-reopen
  autofill.handleOutput("");
  assert.equal(autofill.isPickerPending(), false);
  // Explicit re-open (Esc / arrows in the UI)
  assert.equal(autofill.tryReshowAssist(), true);
  assert.equal(autofill.isPickerPending(), true);
  autofill.confirmFill("host");
  assert.deepEqual(writes, ["host-secret\n"]);
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

test("a bare Password prompt does not hint until a su command is submitted", () => {
  const { autofill, hints } = make();
  autofill.handleOutput("Password: ");
  assert.deepEqual(hints, []);
  // sudo-armed bare Password: is too generic (mysql/ssh); su-armed is expected
  autofill.armForCommand("sudo whoami");
  autofill.handleOutput("Password: ");
  assert.deepEqual(hints, []);
  autofill.armForCommand("su -");
  autofill.handleOutput("Password: ");
  assert.deepEqual(hints, [true]);
});

test("an explicit [sudo] prompt hints without a recorded sudo command", () => {
  // The [sudo] tag is sudo-specific, so we hint even when arming didn't fire —
  // manual typing's recordedCommand is flaky (#1281/#1284), and the hint only
  // pastes on explicit Enter, so showing it is safe.
  const { autofill, hints } = make();
  autofill.handleOutput("[sudo] password for alice: ");
  assert.deepEqual(hints, [true]);
  assert.equal(autofill.isPromptPending(), true);
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

test("cached sudo then child Enter password does not assist", () => {
  // sudo auth already cached: `sudo mysql -p` goes straight to mysql's
  // "Enter password:" — must not offer the host SSH password.
  const { autofill, hints, writes } = make();
  autofill.armForCommand("sudo mysql -p");
  autofill.handleOutput("Enter password: ");
  assert.deepEqual(hints, []);
  assert.deepEqual(writes, []);
  assert.equal(autofill.isPromptPending(), false);
});

test("sudo-scoped bare prompts still assist when armed", () => {
  // Kylin / PAM without [sudo] tag (#1293)
  const kylink = make();
  kylink.autofill.armForCommand("sudo -s");
  kylink.autofill.handleOutput("输入密码");
  assert.deepEqual(kylink.hints, [true]);

  const scoped = make();
  scoped.autofill.armForCommand("sudo whoami");
  scoped.autofill.handleOutput("password for alice: ");
  assert.deepEqual(scoped.hints, [true]);
});

test("a later non-sudo command disarms the pending hint", () => {
  const { autofill, writes, hints } = make();
  autofill.armForCommand("su -");
  autofill.handleOutput("Password: ");
  assert.deepEqual(hints, [true]);
  autofill.armForCommand("mysql -p"); // non-sudo/su command clears the arm
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

test("an expired arm shows no hint for a bare prompt", () => {
  const writes: string[] = [];
  const hints: boolean[] = [];
  let now = 1_000;
  const autofill = createSudoPasswordAutofill({
    password: "secret",
    now: () => now,
    write: (d) => writes.push(d),
    onHint: (a) => {
      hints.push(a);
      return true;
    },
  });
  autofill.armForCommand("su -");
  now += 31_000;
  autofill.handleOutput("Password: ");
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

test("shouldArmSudoPasswordAutofill arms direct sudo and su commands", () => {
  assert.equal(shouldArmSudoPasswordAutofill("sudo whoami"), true);
  assert.equal(shouldArmSudoPasswordAutofill("command sudo whoami"), true);
  assert.equal(shouldArmSudoPasswordAutofill("builtin sudo whoami"), true);
  assert.equal(shouldArmSudoPasswordAutofill("su"), true);
  assert.equal(shouldArmSudoPasswordAutofill("su -"), true);
  assert.equal(shouldArmSudoPasswordAutofill("su root"), true);
  assert.equal(shouldArmSudoPasswordAutofill("su - root"), true);
  assert.equal(shouldArmSudoPasswordAutofill("su -l alice"), true);
  assert.equal(shouldArmSudoPasswordAutofill("command su -"), true);
  assert.equal(shouldArmSudoPasswordAutofill("builtin su"), true);
  assert.equal(shouldArmSudoPasswordAutofill("echo '[sudo] password for alice:'"), false);
  assert.equal(shouldArmSudoPasswordAutofill("cat sudo.log"), false);
  // Word-boundary: do not arm unrelated commands that only start with "su"
  assert.equal(shouldArmSudoPasswordAutofill("sum file"), false);
  assert.equal(shouldArmSudoPasswordAutofill("suspend"), false);
  assert.equal(shouldArmSudoPasswordAutofill("suricata -T"), false);
  assert.equal(shouldArmSudoPasswordAutofill("echo su"), false);
});

test("shows a hint for su Password prompt when armed", () => {
  // su asks for the target account password with a bare "Password:" line
  // (no [sudo] tag), so arming is required (#2156).
  const { autofill, writes, hints } = make();
  autofill.armForCommand("su -");
  assert.equal(autofill.handleOutput("Password: "), "Password: ");
  assert.deepEqual(hints, [true]);
  assert.deepEqual(writes, []);
  assert.equal(autofill.isPromptPending(), true);
  autofill.confirmFill();
  assert.deepEqual(writes, ["secret\n"]);
});

test("su to a named user arms the same confirm-to-fill path", () => {
  const { autofill, writes, hints } = make();
  autofill.armForCommand("su alice");
  autofill.handleOutput("Password: ");
  assert.deepEqual(hints, [true]);
  autofill.confirmFill();
  assert.deepEqual(writes, ["secret\n"]);
});

test("hint mode does not fall back to an unrelated keychain identity", () => {
  // Without a session password, hint must stay silent even when password
  // identities exist — Enter would otherwise paste the wrong secret.
  const writes: string[] = [];
  const hints: boolean[] = [];
  const autofill = createSudoPasswordAutofill({
    mode: "hint",
    candidates: [
      { id: "identity:root", label: "Root", username: "root", password: "root-secret" },
    ],
    write: (d) => writes.push(d),
    onHint: (a) => {
      hints.push(a);
      return true;
    },
  });
  autofill.armForCommand("sudo whoami");
  autofill.handleOutput("[sudo] password for alice: ");
  assert.deepEqual(hints, []);
  assert.equal(autofill.isPromptPending(), false);
  autofill.confirmFill();
  assert.deepEqual(writes, []);
});

test("mode off never hints even for explicit sudo prompts", () => {
  const writes: string[] = [];
  const hints: boolean[] = [];
  const autofill = createSudoPasswordAutofill({
    mode: "off",
    password: "secret",
    write: (d) => writes.push(d),
    onHint: (a) => {
      hints.push(a);
      return true;
    },
  });
  autofill.handleOutput("[sudo] password for alice: ");
  assert.deepEqual(hints, []);
  assert.equal(autofill.isPromptPending(), false);
});

test("isPickerPending is false during hint mode", () => {
  const { autofill } = make();
  autofill.armForCommand("sudo whoami");
  autofill.handleOutput("[sudo] password for alice: ");
  assert.equal(autofill.isPromptPending(), true);
  assert.equal(autofill.isPickerPending(), false);
  assert.equal(autofill.moveSelection(1), false);
});

test("picker mode opens the credential list and fills the selected secret", () => {
  const writes: string[] = [];
  const pickerStates: Array<{ items: { id: string }[]; selectedIndex: number } | null> = [];
  const hints: boolean[] = [];
  const autofill = createSudoPasswordAutofill({
    mode: "picker",
    password: "host-secret",
    candidates: [
      { id: "host", label: "Host", username: "alice", password: "host-secret" },
      { id: "identity:root", label: "Root", username: "root", password: "root-secret" },
    ],
    write: (d) => writes.push(d),
    onHint: (a) => {
      hints.push(a);
      return true;
    },
    onPicker: (active, state) => {
      pickerStates.push(active ? { items: state!.items, selectedIndex: state!.selectedIndex } : null);
      return true;
    },
  });
  autofill.armForCommand("su -");
  autofill.handleOutput("Password: ");
  assert.equal(autofill.isPromptPending(), true);
  assert.equal(pickerStates.length, 1);
  assert.equal(pickerStates[0]?.items.length, 2);
  assert.equal(pickerStates[0]?.selectedIndex, 0);

  assert.equal(autofill.isPickerPending(), true);
  assert.equal(autofill.moveSelection(1), true);
  assert.equal(pickerStates.at(-1)?.selectedIndex, 1);

  autofill.confirmFill();
  assert.deepEqual(writes, ["root-secret\n"]);
  assert.equal(pickerStates.at(-1), null);

  // sudo never opens the multi-identity picker — host-password hint only
  const sudoPicker = createSudoPasswordAutofill({
    mode: "picker",
    password: "host-secret",
    candidates: [
      { id: "host", label: "Host", password: "host-secret" },
      { id: "identity:root", label: "Root", password: "root-secret" },
    ],
    write: () => {},
    onHint: (a) => {
      hints.push(a);
      return true;
    },
    onPicker: (active, state) => {
      pickerStates.push(active ? { items: state!.items, selectedIndex: state!.selectedIndex } : null);
      return true;
    },
  });
  sudoPicker.armForCommand("sudo whoami");
  sudoPicker.handleOutput("[sudo] password for alice: ");
  assert.equal(sudoPicker.isPickerPending(), false);
  assert.equal(sudoPicker.isPromptPending(), true);
});

test("picker confirmFill can target a specific candidate id", () => {
  const writes: string[] = [];
  const autofill = createSudoPasswordAutofill({
    mode: "picker",
    candidates: [
      { id: "host", label: "Host", password: "host-secret" },
      { id: "identity:root", label: "Root", password: "root-secret" },
    ],
    write: (d) => writes.push(d),
    onPicker: () => true,
  });
  autofill.armForCommand("su root");
  autofill.handleOutput("Password: ");
  autofill.confirmFill("identity:root");
  assert.deepEqual(writes, ["root-secret\n"]);
});

test("picker reopens after a wrong password when still armed", () => {
  const writes: string[] = [];
  const pickerActives: boolean[] = [];
  const autofill = createSudoPasswordAutofill({
    mode: "picker",
    candidates: [
      { id: "host", label: "Host", password: "wrong" },
      { id: "identity:root", label: "Root", password: "right" },
    ],
    write: (d) => writes.push(d),
    onPicker: (active) => {
      pickerActives.push(active);
      return true;
    },
  });
  autofill.armForCommand("su -");
  autofill.handleOutput("Password: ");
  assert.equal(autofill.isPickerPending(), true);
  autofill.confirmFill("host");
  assert.deepEqual(writes, ["wrong\n"]);
  assert.equal(autofill.isPickerPending(), false);
  // Remote rejects and re-prompts — picker should open again for another pick
  autofill.handleOutput("\r\nSorry, try again.\r\nPassword: ");
  assert.equal(autofill.isPickerPending(), true);
  autofill.confirmFill("identity:root");
  assert.deepEqual(writes, ["wrong\n", "right\n"]);
});

test("does not re-assist a child password prompt after successful fill", () => {
  // `sudo mysql -p`: after the sudo password is accepted, mysql's own
  // "Enter password:" must not reopen assist with the host secret.
  const { autofill, hints, writes } = make();
  autofill.armForCommand("sudo mysql -p");
  autofill.handleOutput("[sudo] password for alice: ");
  assert.deepEqual(hints, [true]);
  autofill.confirmFill();
  assert.deepEqual(writes, ["secret\n"]);
  autofill.handleOutput("\r\nEnter password: ");
  assert.equal(autofill.isPromptPending(), false);
  assert.deepEqual(hints, [true, false]); // only the original sudo hint
});

test("picker does not open for Enter password when sudo is already cached", () => {
  const writes: string[] = [];
  const pickerActives: boolean[] = [];
  const autofill = createSudoPasswordAutofill({
    mode: "picker",
    candidates: [
      { id: "host", label: "Host", password: "host-secret" },
      { id: "identity:root", label: "Root", password: "root-secret" },
    ],
    write: (d) => writes.push(d),
    onPicker: (active) => {
      pickerActives.push(active);
      return true;
    },
  });
  autofill.armForCommand("sudo mysql -p");
  autofill.handleOutput("Enter password: ");
  assert.equal(autofill.isPickerPending(), false);
  assert.deepEqual(pickerActives, []);
  assert.deepEqual(writes, []);
});

test("picker does not open for database-style Password for user prompts after sudo", () => {
  const hints: boolean[] = [];
  const pickerActives: boolean[] = [];
  const autofill = createSudoPasswordAutofill({
    mode: "picker",
    password: "host-secret",
    candidates: [
      { id: "host", label: "Host", password: "host-secret" },
      { id: "identity:root", label: "Root", password: "root-secret" },
    ],
    write: () => {},
    onHint: (a) => {
      hints.push(a);
      return true;
    },
    onPicker: (active) => {
      pickerActives.push(active);
      return true;
    },
  });
  autofill.armForCommand("sudo -u postgres psql -h db");
  autofill.handleOutput("Password for user postgres: ");
  assert.equal(autofill.isPickerPending(), false);
  assert.deepEqual(pickerActives, []);
  assert.deepEqual(hints, []);
});

test("picker opens for su bare Password after arm", () => {
  const autofill = createSudoPasswordAutofill({
    mode: "picker",
    candidates: [
      { id: "host", label: "Host", password: "host-secret" },
      { id: "identity:root", label: "Root", password: "root-secret" },
    ],
    write: () => {},
    onPicker: () => true,
  });
  autofill.armForCommand("su -");
  autofill.handleOutput("Password: ");
  assert.equal(autofill.isPickerPending(), true);
});

test("passwordless su -c ssh does not open picker for remote password", () => {
  const autofill = createSudoPasswordAutofill({
    mode: "picker",
    candidates: [
      { id: "host", label: "Host", password: "host-secret" },
      { id: "identity:other", label: "Other", password: "other-secret" },
    ],
    write: () => {},
    onPicker: () => true,
  });
  autofill.armForCommand("su bob -c 'ssh other-host'");
  autofill.handleOutput("bob@other-host's password: ");
  assert.equal(autofill.isPickerPending(), false);
  assert.equal(autofill.isPromptPending(), false);
});

test("picker mode requires arm before offering the full keychain list", () => {
  // Unarmed explicit [sudo] must not surface every identity — a remote can
  // forge that line. Host-password hint remains allowed (#2156 security).
  const writes: string[] = [];
  const pickerStates: Array<unknown> = [];
  const hints: boolean[] = [];
  const autofill = createSudoPasswordAutofill({
    mode: "picker",
    password: "host-secret",
    candidates: [
      { id: "host", label: "Host", password: "host-secret" },
      { id: "identity:other", label: "Other", password: "other-secret" },
    ],
    write: (d) => writes.push(d),
    onHint: (a) => {
      hints.push(a);
      return true;
    },
    onPicker: (_active, state) => {
      pickerStates.push(state);
      return true;
    },
  });
  // No armForCommand — forged remote prompt only
  autofill.handleOutput("[sudo] password for alice: ");
  assert.equal(autofill.isPickerPending(), false);
  assert.deepEqual(pickerStates, []);
  assert.deepEqual(hints, [true]);
  autofill.confirmFill();
  assert.deepEqual(writes, ["host-secret\n"]);
});

test("picker mode does not expose passwords in onPicker payload", () => {
  let seen: unknown = null;
  const autofill = createSudoPasswordAutofill({
    mode: "picker",
    candidates: [{ id: "host", label: "Host", password: "top-secret" }],
    write: () => {},
    onPicker: (_active, state) => {
      seen = state;
      return true;
    },
  });
  autofill.armForCommand("su -");
  autofill.handleOutput("Password: ");
  assert.ok(seen && typeof seen === "object");
  const json = JSON.stringify(seen);
  assert.equal(json.includes("top-secret"), false);
});
