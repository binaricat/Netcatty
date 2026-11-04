"""Capture real Bash readline output for OSC readiness regression tests."""
import json
import os
import pty
import select
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


chunks = []
try:
    chunks.append(drain(b"\x1b]133;B\x07"))
    for keys, expected in [(b"x", b"x"), (b"\x7f", b"\b \b"), (b" ", b" "),
                           (b"\x7f", b"\b \b"), (b"hello", b"hello"),
                           (b"\x17", b"\b" * 5 + b" " * 5 + b"\b" * 5),
                           (b"hello world", b"hello world"),
                           (b"\x17", b"\b" * 5 + b" " * 5 + b"\b" * 5),
                           (b"\x15", b"\b" * 6 + b" " * 6 + b"\b" * 6),
                           (b"hello world", b"hello world"),
                           (b"\x15", b"\b" * 11 + b" " * 11 + b"\b" * 11),
                           (b"hello", b"hello"), (b"\x01", b"\b" * 5),
                           (b"\x0b", b" " * 5 + b"\b" * 5),
                           (b"hello world", b"hello world"),
                           (b"\x02" * 5, b"\b" * 5),
                           (b"\x0b", b" " * 5 + b"\b" * 5),
                           (b"\x15", b"\b" * 6 + b" " * 6 + b"\b" * 6),
                           (b"hello world", b"hello world"), (b"\x01", b"\b" * 11),
                           (b"\x06" * 6, b"hello "),
                           (b"\x0b", b" " * 5 + b"\b" * 5),
                           (b"\x15", b"\b" * 6 + b" " * 6 + b"\b" * 6),
                           (b"\x03", b"\x1b]133;B\x07"),
                           (b"   ", b"   "), (b"\x02" * 3, b"\b" * 3),
                           (b"\x06" * 3, b"   "), (b"\x02" * 3, b"\b" * 3),
                           (b"\x0b", b" " * 3 + b"\b" * 3),
                           (b'echo "unfinished\n', b"> ")]:
        os.write(master, keys)
        chunks.append(drain(expected))
finally:
    shell.kill()
    shell.wait(timeout=3)
    os.close(master)

print(json.dumps(chunks))
