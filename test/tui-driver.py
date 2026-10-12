#!/usr/bin/env python3
"""Automated real-terminal acceptance against isolated deterministic fixtures only."""
import codecs
import errno
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time
from pathlib import Path

workspace = Path.cwd()
agent = Path(os.environ["PI_CODING_AGENT_DIR"])
pid, fd = pty.fork()
if pid == 0:
    env = dict(os.environ, TERM="xterm-256color")
    os.execvpe(sys.argv[1], sys.argv[1:], env)

os.set_blocking(fd, False)
buffer = ""
decoder = codecs.getincrementaldecoder("utf-8")("replace")

def size(cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    os.kill(pid, signal.SIGWINCH)

def plain(text):
    text = re.sub(r"\x1b\][^\x07]*(?:\x07|\x1b\\)", "", text)
    return re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)

def pump(timeout=0.05):
    global buffer
    if select.select([fd], [], [], timeout)[0]:
        try:
            data = os.read(fd, 65536)
        except BlockingIOError:
            return
        except OSError as error:
            if error.errno == errno.EIO:
                raise RuntimeError("Pi terminal exited unexpectedly")
            raise
        if not data:
            raise RuntimeError("Pi terminal closed unexpectedly")
        buffer += decoder.decode(data)

def wait(text, start=0):
    print("PTY waiting:", text, file=sys.stderr, flush=True)
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if text in plain(buffer[start:]):
            return
        pump()
    raise RuntimeError("Terminal deadline waiting for " + repr(text) + "\n" + plain(buffer[-5000:]))

def send(text):
    start = len(buffer)
    os.write(fd, text.encode())
    return start

def command(text):
    return send(text + "\r")

def revisions():
    return sorted((agent / "pi-planroom" / "plans").glob("*/*.json"), key=lambda p: int(p.stem))

def wait_revision(number):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        paths = revisions()
        if paths and int(paths[-1].stem) == number:
            return json.loads(paths[-1].read_text())
        pump()
    raise RuntimeError("Revision was not persisted")

try:
    size(100, 35)
    wait("Encoding decision for fixture")
    mark = send("\x1b")
    wait("Decision remains open", mark)
    assert not revisions()
    command("/plan answer encoding Keep fixture encoding")
    time.sleep(0.1)
    command("/plan revise Continue with the confirmed fixture encoding")
    wait("plan: ready")
    first = wait_revision(1)
    assert not (workspace / "denied.txt").exists()
    assert not (workspace / "result.txt").exists()

    mark = command("/plan show")
    wait("Planroom revision 1", mark)
    send("\x1b[6~")  # PageDown
    size(50, 15)
    for _ in range(5):
        pump()
    mark = send("\x1b[6~")
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        starts = re.findall(r"(\d+)–\d+ / \d+", plain(buffer[mark:]))
        if any(int(row) > 1 for row in starts):
            break
        pump()
    else:
        raise RuntimeError("PageDown did not move the real terminal viewport")
    size(100, 35)
    send("\x1b")
    time.sleep(0.1)

    mark = command("/plan edit")
    wait("Edit Checked result", mark)
    send("\x1b[A" * 40 + "\x1b[H" + "\x0b" + "# Revised result" + "\r")
    second = wait_revision(2)
    assert second["title"] == "Revised result", second["title"]
    assert second["parent"] == first["hash"]
    assert not (workspace / "result.txt").exists()

    mark = command("/plan diff")
    wait("Revision 1", mark)
    send("\x1b")
    time.sleep(0.1)

    # The real session replacement path, not a mocked newSession callback.
    mark = command("/plan fresh")
    wait("Fresh-session handoff", mark)
    mark = send("\x1b")
    wait("Create a fresh linked session?", mark)
    mark = send("\r")
    wait("Revised result", mark)
    # Destination plan viewer -> model selection -> decline exact approval.
    mark = send("\x1b")
    wait("Implementation model", mark)
    mark = send("\r")
    wait("Approve exact plan revision", mark)
    mark = send("j")  # Explicit No; do not depend on lone-Escape timing across PTYs.
    wait("→ No", mark)
    send("\r")
    for _ in range(6):
        pump()
    assert not (workspace / "result.txt").exists()

    mark = command("/plan implement")
    wait("Revised result", mark)
    mark = send("\x1b")
    wait("Implementation model", mark)
    mark = send("\r")
    wait("Approve exact plan revision", mark)
    mark = send("\r")
    wait("plan: completed", mark)
    assert (workspace / "result.txt").read_text() == "done\n"
    assert not (workspace / "denied.txt").exists()
    sessions = list((agent / "sessions").rglob("*.jsonl"))
    headers = [json.loads(path.read_text().splitlines()[0]) for path in sessions]
    assert any(header.get("parentSession") for header in headers), "No linked destination persisted"
    print("Real PTY qualified: question dismissal/explicit answer, Markdown scroll/resize, direct edit/parent diff, fresh linked destination, declined approval inert, approved fixture completion.")
finally:
    try:
        send("\x04")
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            if os.waitpid(pid, os.WNOHANG)[0]:
                break
            time.sleep(0.05)
        else:
            os.kill(pid, signal.SIGTERM)
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                if os.waitpid(pid, os.WNOHANG)[0]:
                    break
                time.sleep(0.05)
            else:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
    except (ProcessLookupError, ChildProcessError, OSError):
        pass
    os.close(fd)
