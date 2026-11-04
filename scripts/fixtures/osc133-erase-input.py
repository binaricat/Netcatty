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
                           (b"\x7f", b"\b \b"), (b'echo "unfinished\n', b"> ")]:
        os.write(master, keys)
        chunks.append(drain(expected))
finally:
    shell.kill()
    shell.wait(timeout=3)
    os.close(master)

print(json.dumps(chunks))
