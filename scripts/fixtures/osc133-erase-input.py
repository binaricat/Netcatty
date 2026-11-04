"""Capture real Bash readline output for OSC readiness regression tests."""
import json
import fcntl
import os
import pty
import select
import signal
import subprocess
import sys
import termios
import tempfile
import time

env = dict(os.environ)
available_locales = subprocess.run(["locale", "-a"], capture_output=True, text=True).stdout.splitlines()
utf8_locale = next((name for name in available_locales if name.lower().replace("-", "").endswith("utf8")), None)
if utf8_locale is None:
    sys.exit(77)
prompt_text = "review@\u754c\u4e3b\u673a:~$ " if "--wide-prompt" in sys.argv else "review@local:~$ "
env.update(
    PS1=r"\[\e]133;A\a\]" + prompt_text + r"\[\e]133;B\a\]",
    PS2="> ", HISTFILE="/dev/null", TERM="dumb", LC_ALL=utf8_locale,
    INPUTRC="/dev/null", PROMPT_COMMAND="",
)
def prepare_pty_child():
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)
    signal.signal(signal.SIGINT, signal.SIG_DFL)
    signal.signal(signal.SIGQUIT, signal.SIG_DFL)
    signal.pthread_sigmask(signal.SIG_SETMASK, [])




def drain(expected):
    data = b""
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], 0.02)
        if readable:
            data += os.read(master, 65536)
            if expected in data:
                return data.decode("utf-8", errors="replace")
    raise RuntimeError(f"Bash PTY expected {expected!r}, got {data!r}")


def readline_ready():
    # PS1 can be printed before readline has installed its terminal handlers.
    # Ctrl-G's audible abort acknowledges that the input loop processed a key.
    os.write(master, b"\x07")
    return drain(b"\x07")


# Each scenario starts with a fresh prompt so an intentionally conservative
# blank-only result cannot contaminate a later independent editing case.
bs = lambda n: b"\b" * n
erase = lambda n: bs(n) + b" " * n + bs(n)
cases = [
    ("character and blank deletion", [
        ("type x", b"x", b"x", False), ("delete x", b"\x7f", erase(1), False),
        ("type blank", b" ", b" ", False),
        ("delete blank is ambiguous", b"\x7f", erase(1), False)]),
    ("Ctrl-W whole word", [("type hello", b"hello", b"hello", False),
        ("kill word", b"\x17", erase(5), False)]),
    ("Ctrl-W leaves input", [("type two words", b"hello world", b"hello world", False),
        ("kill last word", b"\x17", erase(5), False),
        ("kill mixed prefix conservatively", b"\x15", erase(6), False)]),
    ("Ctrl-U mixed line", [("type two words", b"hello world", b"hello world", False),
        ("kill mixed line conservatively", b"\x15", erase(11), False)]),
    ("Ctrl-K whole text", [("type hello", b"hello", b"hello", False),
        ("home", b"\x01", bs(5), False),
        ("kill suffix", b"\x0b", b" " * 5 + bs(5), False)]),
    ("Ctrl-K leaves input", [("type two words", b"hello world", b"hello world", False),
        ("move left", b"\x02" * 5, bs(5), False),
        ("kill last word", b"\x0b", b" " * 5 + bs(5), False),
        ("kill mixed prefix conservatively", b"\x15", erase(6), False)]),
    ("Ctrl-K after prompt redraw", [("type two words", b"hello world", b"hello world", False),
        ("home", b"\x01", bs(11), False),
        ("move right redraws prompt", b"\x06" * 6, b"hello ", False),
        ("kill suffix", b"\x0b", b" " * 5 + bs(5), False),
        ("kill prefix with unknown suffix", b"\x15", erase(6), False)]),
    ("pending blank navigation", [("type three blanks", b"   ", b"   ", False),
        ("move left", b"\x02" * 3, bs(3), False),
        ("move right", b"\x06" * 3, b"   ", False),
        ("move left again", b"\x02" * 3, bs(3), False),
        ("kill blank suffix conservatively", b"\x0b", b" " * 3 + bs(3), False)]),
    ("mixed forward delete", [("type x and blank", b"x ", b"x ", False),
        ("home", b"\x01", bs(2), False),
        ("delete x leaves blank", b"\x04", b"  " + bs(2), False)]),
    ("indistinguishable mixed line kill", [("type x and blank", b"x ", b"x ", False),
        ("kill line remains ambiguous", b"\x15", erase(2), False)]),
    ("repeated forward text deletion", [("type xy", b"xy", b"xy", False),
        ("home", b"\x01", bs(2), False),
        ("delete x leaves y", b"\x04", b"y " + bs(2), False),
        ("delete y clears text", b"\x04", b" " + bs(1), False)]),
    ("repeated mixed forward deletion", [("type xy and blank", b"xy ", b"xy ", False),
        ("home", b"\x01", bs(3), False),
        ("delete x leaves y and blank", b"\x04", b"y  " + bs(3), False),
        ("delete y leaves blank", b"\x04", b"  " + bs(2), False)]),
    ("leading blank forward deletion", [("type blank and x", b" x", b" x", False),
        ("home", b"\x01", bs(2), False),
        ("delete blank leaves x", b"\x04", b"x " + bs(2), False),
        ("delete x clears text", b"\x04", b" " + bs(1), False)]),
    ("unfinished quote", [("continue quote", b'echo "unfinished\n', b"> ", False)]),
    ("wide CJK deletion", [("type wide glyph", "\u754c".encode(), "\u754c".encode(), False),
        ("delete wide glyph", b"\x7f", erase(2), False)]),
    ("partial CJK deletion", [("type two wide glyphs", "\u4e2d\u6587".encode(), "\u4e2d\u6587".encode(), False),
        ("delete one keeps input", b"\x7f", erase(2), False),
        ("delete remainder", b"\x7f", erase(2), False)]),
    ("combining mark deletion", [("type combining text", "e\u0301".encode(), "e\u0301".encode(), False),
        ("delete composed text", b"\x7f", erase(1), False)]),
    ("emoji deletion", [("type emoji", "\U0001f600".encode(), "\U0001f600".encode(), False),
        ("delete emoji", b"\x7f", erase(2), False)]),
    ("partial emoji modifier deletion", [("type modified emoji", "\U0001f44d\U0001f3fd".encode(), "\U0001f44d\U0001f3fd".encode(), False),
        ("delete modifier keeps base", b"\x7f", erase(2), False)]),
    ("partial joined emoji deletion", [("type joined emoji", "\U0001f468\u200d\U0001f469\u200d\U0001f467".encode(), "\U0001f468\u200d\U0001f469\u200d\U0001f467".encode(), False),
        ("delete last emoji keeps prefix", b"\x7f", erase(2), False)]),
    ("partial flag deletion", [("type flag", "\U0001f1e8\U0001f1f3".encode(), "\U0001f1e8\U0001f1f3".encode(), False),
        ("delete one indicator keeps input", b"\x7f", erase(1), False)]),
    ("spacing mark deletion", [("type base and spacing mark", "x\u093e".encode(), "x\u093e".encode(), False),
        ("delete spacing mark keeps base", b"\x7f", erase(1), False)]),
    ("soft hyphen deletion", [("type base and soft hyphen", "x\u00ad".encode(), "x\u00ad".encode(), False),
        ("delete soft hyphen keeps base", b"\x7f", erase(1), False)]),
    ("decomposed Hangul deletion", [("type decomposed syllable", "\u1100\u1161\u11a8".encode(), "\u1100\u1161\u11a8".encode(), False),
        ("delete syllable", b"\x7f", erase(2), False)]),
    ("zero width space deletion", [("type base and zero width space", "x\u200b".encode(), "x\u200b".encode(), False),
        ("delete combined text", b"\x7f", erase(1), False)]),
    ("invisible format deletion", [("type base and letter mark", "x\u061c".encode(), "x\u061c".encode(), False),
        ("delete combined text", b"\x7f", erase(1), False)]),
    ("variation selector deletion", [("type base and selector", "x\ufe0f".encode(), "x\ufe0f".encode(), False),
        ("delete combined text", b"\x7f", erase(1), False)]),
]

risk_probes = "--risk-probes" in sys.argv
rc_directory = tempfile.TemporaryDirectory(prefix="netcatty-readline-")
rc_path = os.path.join(rc_directory.name, "bashrc")
with open(rc_path, "w", encoding="ascii") as rc:
    rc.write(r'''PS1=$NETCATTY_TEST_PS1
PS2="> "
__capture_readline() { printf '\n__READLINE_BEGIN__%s__READLINE_END__\n' "$READLINE_LINE"; }
bind -m vi-command -x '"\C-x\C-p":__capture_readline'
bind -m vi-insert '"\C-g":abort'
bind -m vi-insert -x '"\C-x\C-p":__capture_readline'
bind -m emacs-standard -x '"\C-x\C-p":__capture_readline'
''')

scenarios = []


def interrupted(_signal, _frame):
    raise RuntimeError("Bash fixture interrupted")


signal.signal(signal.SIGTERM, interrupted)
if risk_probes:
    cases = [
        ("vi replacement leaves genuine blank", [
            ("type x", b"x", b"x", False),
            ("vi replace x with blank", b"\x1br ", b"\b \b", False)]),
        ("multiline prompt Ctrl-L redraw", [
            ("type pending command", b"echo pending", b"echo pending", False),
            ("redraw multiline PS1", b"\x0c", b"\x1b]133;B\x07", False)]),
    ]

for name, steps in cases:
    master, slave = pty.openpty()
    shell = None
    try:
        case_env = dict(env)
        if risk_probes and name.startswith("vi"):
            with open(rc_path, "a", encoding="ascii") as rc:
                rc.write("set -o vi\n")
        if risk_probes and name.startswith("multiline"):
            case_env["TERM"] = "xterm-256color"
            case_env["PS1"] = r"\[\e]133;A\a\]header\n" + prompt_text + r"\[\e]133;B\a\]"
            # Select the normal emacs map after the preceding vi scenario.
            with open(rc_path, "a", encoding="ascii") as rc:
                rc.write("set -o emacs\n")
        case_env["NETCATTY_TEST_PS1"] = case_env["PS1"]
        shell = subprocess.Popen(
            ["/bin/bash", "--noprofile", "--rcfile", rc_path, "-i"],
            stdin=slave, stdout=slave, stderr=slave, env=case_env, preexec_fn=prepare_pty_child,
        )
        os.close(slave)
        slave = None
        prompt = drain(b"\x1b]133;B\x07") + readline_ready()
        states = [dict(step="fresh prompt", raw=prompt, ready=True)]
        for step, keys, expected, ready in steps:
            os.write(master, keys)
            try:
                raw = drain(expected)
            except RuntimeError as error:
                raise RuntimeError(f"{name}: {step}") from error
            states.append(dict(step=step, raw=raw, ready=ready))
        scenario = dict(name=name, states=states)
        if risk_probes:
            os.write(master, b"\x18\x10")
            proof = drain(b"__READLINE_END__")
            scenario["readline_line"] = proof.split("__READLINE_BEGIN__", 1)[1].split("__READLINE_END__", 1)[0]
        scenarios.append(scenario)
    finally:
        if shell is not None:
            shell.kill()
            shell.wait(timeout=3)
        if slave is not None:
            os.close(slave)
        os.close(master)

rc_directory.cleanup()
print(json.dumps(scenarios))
