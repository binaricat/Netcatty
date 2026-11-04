"""Capture real Bash readline output for OSC readiness regression tests."""
import json
import os
import pty
import select
import signal
import subprocess
import time

env = dict(os.environ)
env.update(
    PS1=r"\[\e]133;A\a\]review@local:~$ \[\e]133;B\a\]",
    PS2="> ", HISTFILE="/dev/null", TERM="dumb",
)
master, slave = pty.openpty()
shell = subprocess.Popen(
    ["/bin/bash", "--noprofile", "--norc", "-i"],
    stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True,
)
os.close(slave)


def drain(expected):
    data = b""
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], 0.02)
        if readable:
            data += os.read(master, 65536)
            if expected in data:
                return data.decode("utf-8", errors="replace")
    raise RuntimeError("Bash did not emit the expected local PTY output")


# Each scenario starts with a fresh prompt so an intentionally conservative
# blank-only result cannot contaminate a later independent editing case.
bs = lambda n: b"\b" * n
erase = lambda n: bs(n) + b" " * n + bs(n)
cases = [
    ("character and blank deletion", [
        ("type x", b"x", b"x", False), ("delete x", b"\x7f", erase(1), True),
        ("type blank", b" ", b" ", False),
        ("delete blank is ambiguous", b"\x7f", erase(1), False)]),
    ("Ctrl-W whole word", [("type hello", b"hello", b"hello", False),
        ("kill word", b"\x17", erase(5), True)]),
    ("Ctrl-W leaves input", [("type two words", b"hello world", b"hello world", False),
        ("kill last word", b"\x17", erase(5), False),
        ("kill mixed prefix conservatively", b"\x15", erase(6), False)]),
    ("Ctrl-U mixed line", [("type two words", b"hello world", b"hello world", False),
        ("kill mixed line conservatively", b"\x15", erase(11), False)]),
    ("Ctrl-K whole text", [("type hello", b"hello", b"hello", False),
        ("home", b"\x01", bs(5), False),
        ("kill suffix", b"\x0b", b" " * 5 + bs(5), True)]),
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
        ("delete y clears text", b"\x04", b" " + bs(1), True)]),
    ("repeated mixed forward deletion", [("type xy and blank", b"xy ", b"xy ", False),
        ("home", b"\x01", bs(3), False),
        ("delete x leaves y and blank", b"\x04", b"y  " + bs(3), False),
        ("delete y leaves blank", b"\x04", b"  " + bs(2), False)]),
    ("leading blank forward deletion", [("type blank and x", b" x", b" x", False),
        ("home", b"\x01", bs(2), False),
        ("delete blank leaves x", b"\x04", b"x " + bs(2), False),
        ("delete x clears text", b"\x04", b" " + bs(1), True)]),
    ("unfinished quote", [("continue quote", b'echo "unfinished\n', b"> ", False)]),
]

scenarios = []


def interrupted(_signal, _frame):
    raise RuntimeError("Bash fixture interrupted")


try:
    signal.signal(signal.SIGTERM, interrupted)
    drain(b"\x1b]133;B\x07")
    for name, steps in cases:
        os.write(master, b"\x03")
        states = [dict(step="fresh prompt", raw=drain(b"\x1b]133;B\x07"), ready=True)]
        for step, keys, expected, ready in steps:
            os.write(master, keys)
            states.append(dict(step=step, raw=drain(expected), ready=ready))
        scenarios.append(dict(name=name, states=states))
finally:
    shell.kill()
    shell.wait(timeout=3)
    os.close(master)

print(json.dumps(scenarios))
