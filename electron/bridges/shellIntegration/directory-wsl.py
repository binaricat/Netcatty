import base64
import json
import os
import pwd
import sys


def process_stat(path):
    try:
        with open(path + '/stat', encoding='utf-8', errors='replace') as stream:
            fields = stream.read().rsplit(') ', 1)[1].split()
        return tuple(int(fields[index]) for index in (1, 2, 3, 4, 5, 19))
    except (OSError, ValueError, IndexError):
        return None


def marked(path, marker):
    try:
        if os.stat(path).st_uid != os.geteuid():
            return False
        with open(path + '/environ', 'rb') as stream:
            return marker in stream.read(256 * 1024).split(b'\0')
    except OSError:
        return False


def interactive_bash(marker, expected):
    processes = {}
    tagged = set()
    with os.scandir('/proc') as entries:
        for entry in entries:
            if not entry.name.isdecimal():
                continue
            stat = process_stat(entry.path)
            if stat and stat[3]:
                pid = int(entry.name)
                processes[pid] = stat
                if marked(entry.path, marker):
                    tagged.add(pid)
    roots = [pid for pid in tagged if processes[pid][0] not in tagged]
    if len(roots) != 1:
        return None
    pid = roots[0]
    stat = processes[pid]
    _, group, session, tty, foreground, started = stat
    identity = f'{pid}:{started}'
    if (expected and identity != expected) or group != pid or foreground not in (0, group):
        return None
    # WSL 1 can report foreground group 0. In both modes, a peer on the
    # same terminal other than the launcher means the original Bash is busy.
    ancestors = {pid}
    parent = stat[0]
    while parent in processes and parent not in ancestors:
        ancestors.add(parent)
        parent = processes[parent][0]
    if any(other not in ancestors and row[2:4] == (session, tty) for other, row in processes.items()):
        return None
    proc = f'/proc/{pid}'
    if os.path.basename(os.readlink(proc + '/exe')) != 'bash':
        return None
    return proc, identity, stat


def directory_result(operation, encoded_path, cwd):
    if operation == 'cwd':
        return {}
    path = base64.b64decode(encoded_path, validate=True).decode('utf-8')
    if operation == 'realpath':
        canonical = os.path.realpath(path, strict=True)
        if not os.path.isdir(canonical):
            raise NotADirectoryError(canonical)
        return {'path': canonical}
    if path != cwd:
        return {'error': 'unavailable'}
    files = []
    with os.scandir(path) as entries:
        for entry in entries:
            try:
                entry.name.encode('utf-8')
                if entry.is_dir():
                    files.append({'name': entry.name, 'type': 'directory'})
            except (FileNotFoundError, UnicodeError):
                continue
            if len(files) > 4096:
                raise ValueError('Directory listing exceeds limit')
    return {'files': files}


def main(operation, nonce, expected, encoded_path):
    try:
        marker = ('NETCATTY_WSL_DIRECTORY_SESSION=' + nonce).encode('ascii')
        match = interactive_bash(marker, expected)
        if not match:
            return {'error': 'unavailable'}
        proc, identity, stat = match
        cwd = os.readlink(proc + '/cwd')
        result = directory_result(operation, encoded_path, cwd)
        if process_stat(proc) != stat or os.readlink(proc + '/cwd') != cwd:
            return {'error': 'unavailable'}
        return {'identity': identity, 'cwd': cwd, 'home': pwd.getpwuid(os.geteuid()).pw_dir, **result}
    except PermissionError:
        return {'error': 'accessDenied'}
    except (OSError, ValueError, KeyError):
        return {'error': 'readFailed'}


print(json.dumps(main(*sys.argv[1:]), ensure_ascii=True))
