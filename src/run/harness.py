"""Runs one Python block and reports what happened: the counterpart of harness.cjs.

It speaks harness.cjs's messages, as JSON lines: one "start" line
in on stdin, then "resume" and "breakpoints" lines; events and one "result" line out
on a private duplicate of stdout. File descriptor 1 itself, and so sys.stdout, go to
os.devnull, so nothing a block or a package prints can be mistaken for a report.
Stderr is left alone, for tracebacks.

Tracing wraps each block function in place, by swapping its __code__ for a
trampoline into this harness, so every reference to the function object sees the
call: a from-import taken before tracing started, a module attribute, a dict, a
default argument or a partial. The call running now is carried in a ContextVar,
which asyncio copies into every task it starts, so asyncio.gather keeps parents.

Started as:  python -I -B -X utf8 harness.py
The start spec is harness.cjs's, plus "root": the folder the block files were
copied into, which is put first on sys.path.
"""

import asyncio
import contextvars
import importlib
import importlib.util
import inspect
import json
import os
import random
import re
import sys
import sysconfig
import threading
import time
import types

# The protocol goes over private duplicates of fd 1 and fd 0. The fds
# themselves then point at os.devnull, so nothing a block or a package prints
# can be mistaken for a report, and a block reading stdin meets EOF at once —
# as it does under harness.cjs — instead of eating the person's next resume.
_proto = os.fdopen(os.dup(1), "w", encoding="utf-8", newline="\n")
os.dup2(os.open(os.devnull, os.O_WRONLY), 1)
_control = os.fdopen(os.dup(0), "r", encoding="utf-8")
os.dup2(os.open(os.devnull, os.O_RDONLY), 0)

MOST_CALLS_RECORDED = 2000
LARGEST_VALUE_RECORDED = 200_000


def _json(value):
    # Compact and unescaped, so a value's length is what JSON.stringify would give.
    return json.dumps(value, allow_nan=False, ensure_ascii=False, separators=(",", ":"))


def send(message):
    try:
        _proto.write(_json(message) + "\n")
        _proto.flush()
    except (BrokenPipeError, OSError):
        os._exit(0)  # Fragmentor has gone: there is no one left to report to.


logs = []
project_dir = ""
copy_of = None
stores = {}


def copy(value):
    """A copy, so nothing a block keeps a reference to can change what a store holds."""
    return json.loads(_json(value))


def store_state(target, kind):
    state = stores.get(target)
    if state is None:
        state = {"kind": "queue", "sent": []} if kind == "queue" else {"kind": "store", "rows": {}}
        stores[target] = state
    return state


def inside_project(target, project=None):
    """Nothing a block does may touch a file outside the project it belongs to."""
    root = os.path.abspath(project if project is not None else project_dir)
    resolved = os.path.abspath(os.path.join(root, target))
    try:
        relative = os.path.relpath(resolved, root)
    except ValueError:  # on another drive
        relative = resolved
    if relative == ".." or relative.startswith(".." + os.sep) or os.path.isabs(relative):
        raise PermissionError(f"{target} is outside the project, so the test bench will not open it.")
    return resolved


class Store:
    def __init__(self, port):
        self._target = port.get("target")
        self._state = store_state(self._target, "store")
        self._state["rows"].update(copy(port.get("seed") or {}))

    async def read(self, key):
        rows = self._state["rows"]
        row = copy(rows[str(key)]) if str(key) in rows else None
        report_store(self._target, "read", str(key), row)
        return row

    async def list(self):
        rows = [copy(row) for row in self._state["rows"].values()]
        report_store(self._target, "list", None, rows)
        return rows

    async def write(self, key, row):
        self._state["rows"][str(key)] = copy(row)
        report_store(self._target, "write", str(key), row)

    async def remove(self, key):
        # What a remove took away is read first, so a run can be seen to have
        # removed the row it meant to, and not merely to have asked.
        removed = self._state["rows"].pop(str(key), None)
        report_store(self._target, "remove", str(key), removed)


class Queue:
    def __init__(self, port):
        self._target = port.get("target")
        self._state = store_state(self._target, "queue")

    async def send(self, message):
        self._state["sent"].append(copy(message))
        report_store(self._target, "send", None, message)


class FileSystem:
    # A copy holds only the blocks and their code, so a file it does not hold is
    # read from the project it copies. What a run writes stays in the copy.
    def __init__(self, port):
        pass

    async def read_file(self, path):
        # newline="" keeps the file's own line endings, as harness.cjs does.
        try:
            with open(inside_project(path), encoding="utf-8", newline="") as f:
                return f.read()
        except FileNotFoundError:
            if copy_of is None:
                raise
            with open(inside_project(path, copy_of), encoding="utf-8", newline="") as f:
                return f.read()

    async def write_file(self, path, contents):
        file = inside_project(path)
        if copy_of is not None:
            os.makedirs(os.path.dirname(file), exist_ok=True)
        with open(file, "w", encoding="utf-8", newline="") as f:
            f.write(contents)


class Logger:
    def __init__(self, port):
        pass

    def log(self, message):
        logs.append(str(message))


class Clock:
    def __init__(self, port):
        pass

    def now(self):
        return int(time.time() * 1000)


class Random:
    def __init__(self, port):
        pass

    def next(self):
        return random.random()


class Http:
    def __init__(self, port):
        pass

    async def get(self, url):
        raise RuntimeError("The test bench does not provide network access. Substitute this capability to test the block.")


SUBSTITUTES = {each.__name__: each for each in (Store, Queue, FileSystem, Logger, Clock, Random, Http)}


def build_capabilities(spec):
    caps = {}
    for entry in spec:
        make = SUBSTITUTES.get(entry["capability"])
        if make is None:
            raise LookupError(f'No test-bench substitute for the capability "{entry["capability"]}".')
        caps[entry["name"]] = make(entry)
    return types.SimpleNamespace(**caps)


def message_of(error):
    text = str(error)
    return f"{type(error).__name__}: {text}" if text else type(error).__name__


# ---------------------------------------------------------------------------
# Tracing
# ---------------------------------------------------------------------------


def recordable(value):
    try:
        text = _json(value)
    except (TypeError, ValueError, RecursionError):
        return "(a value that cannot be written as JSON)"
    return f"(a value too large to record: {len(text)} characters of JSON)" if len(text) > LARGEST_VALUE_RECORDED else value


within = contextvars.ContextVar("within", default=None)
started = time.monotonic()
calls = 0  # block calls and store uses, counted together, so each has an id of its own
tracing = False
breakpoints = set()
stepping = False
held = []  # [call id, block path, future], the first being the one reported paused
loop = None
originals = {}  # index -> (block path, the function as it was)


def at():
    return int((time.monotonic() - started) * 1000)


def report_store(target, op, key, value):
    global calls
    if not tracing or target is None:
        return
    calls += 1
    if calls > MOST_CALLS_RECORDED:
        return
    message = {"type": "store", "id": calls, "parent": within.get(), "target": target, "op": op}
    if key is not None:
        message["key"] = key
    message["value"] = recordable(value)
    message["at"] = at()
    send(message)


def report_first():
    if held:
        send({"type": "paused", "id": held[0][0]})


def hold(call_id, block_path, ahead):
    future = loop.create_future()
    entry = (call_id, block_path, future)
    # A step goes into the call it let go, so what that call starts comes next.
    if ahead:
        held.insert(0, entry)
    else:
        held.append(entry)
    if ahead or len(held) == 1:
        report_first()
    return future


def let_go(entry):
    send({"type": "resumed", "id": entry[0]})
    if not entry[2].done():
        entry[2].set_result(None)


def release_next(mode):
    global stepping
    if not held:
        return
    nxt = held.pop(0)
    stepping = mode == "step"
    let_go(nxt)
    if mode != "step":
        for entry in [e for e in held if e[1] not in breakpoints]:
            held.remove(entry)
            let_go(entry)
    if mode == "block":
        for entry in [e for e in held if e[1] == nxt[1]]:
            held.remove(entry)
            let_go(entry)
    report_first()


async def enter(index, args, kwargs):
    """What every wrapped block function runs instead of its own body."""
    global calls, stepping
    block_path, original = originals[index]
    calls += 1
    call_id = calls
    recorded = call_id <= MOST_CALLS_RECORDED
    if recorded:
        value = args[0] if args else kwargs.get("input")
        send({"type": "call", "id": call_id, "parent": within.get(), "block": block_path, "input": recordable(value), "at": at()})
        if stepping or block_path in breakpoints:
            ahead = stepping
            stepping = False
            await hold(call_id, block_path, ahead)
    token = within.set(call_id)
    try:
        output = await original(*args, **kwargs)
    except BaseException as error:
        if recorded:
            send({"type": "throw", "id": call_id, "error": message_of(error), "at": at()})
        raise
    finally:
        within.reset(token)
    if recorded:
        send({"type": "return", "id": call_id, "output": recordable(output), "at": at()})
    return output


TRAMPOLINE = """
async def trampoline(*args, **kwargs):
    return await __import__("sys").modules["__fragmentor_harness__"].enter({index}, args, kwargs)
"""


def wrap_in_place(index, block_path, fn):
    """Makes the function object itself call through the harness, so every reference to it does."""
    if not isinstance(fn, types.FunctionType) or not inspect.iscoroutinefunction(fn):
        raise TypeError(f"{block_path}: {getattr(fn, '__qualname__', fn)!s} is not a plain async def, so Fragmentor cannot watch it.")
    if fn.__code__.co_freevars:
        raise TypeError(
            f"{block_path}: {fn.__qualname__} uses variables from a function around it "
            f"({', '.join(fn.__code__.co_freevars)}), so Fragmentor cannot watch it. Make it a top-level async def."
        )
    original = types.FunctionType(fn.__code__, fn.__globals__, fn.__name__, fn.__defaults__, fn.__closure__)
    original.__kwdefaults__ = fn.__kwdefaults__
    namespace = {}
    exec(TRAMPOLINE.format(index=index), namespace)
    originals[index] = (block_path, original)
    fn.__code__ = namespace["trampoline"].__code__.replace(co_name=fn.__code__.co_name, co_qualname=fn.__code__.co_qualname)


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------


def _under(path, root):
    path, root = os.path.normcase(os.path.abspath(path)), os.path.normcase(os.path.abspath(root))
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


def _what(spec):
    if spec.origin in ("built-in", "frozen"):
        return f"Python's own built-in module {spec.name}"
    where = spec.origin if spec.origin not in (None, "namespace") else list(spec.submodule_search_locations or [])[0]
    stdlib = sysconfig.get_paths()["stdlib"]
    kind = "Python's own module" if _under(where, stdlib) and "site-packages" not in where else "the installed package"
    return f"{kind} {spec.name} ({where})"


def load(file, root):
    """Imports a block's file by its module name under root, and makes sure it is that file."""
    relative = os.path.relpath(file, root)
    name = relative[:-3].replace(os.sep, ".")
    top = name.split(".")[0]
    # Only a top-level name is looked up, so no package's __init__ runs here.
    spec = importlib.util.find_spec(top)
    own = spec is not None and (
        any(_under(location, root) for location in (spec.submodule_search_locations or []))
        or (spec.origin not in (None, "namespace", "built-in", "frozen") and _under(spec.origin, root))
    )
    if spec is not None and not own:
        # What the name hides may be the block's own file rather than a folder.
        ours = f"{top}.py" if name == top else f"the {top} folder"
        raise ImportError(f"{relative} cannot be imported: the name {top} is taken by {_what(spec)}, which hides the project's {ours}. Rename yours.")
    module = importlib.import_module(name)
    if not _under(getattr(module, "__file__", None) or "", file):
        raise ImportError(f"{name} was loaded from {getattr(module, '__file__', None)}, not from {relative}.")
    return module


CONTRACT_NAME = re.compile(r"\w+(Input|Caps|Output)")


def explain(error, root):
    """The sentence a failed run reports."""
    if isinstance(error, NameError) and CONTRACT_NAME.fullmatch(getattr(error, "name", None) or ""):
        frames = [frame.filename for frame in __import__("traceback").extract_tb(error.__traceback__) if _under(frame.filename, root)]
        # Only where the future import is really missing: a file that already
        # has it is using the type-only name for real, and the advice would
        # not fix that.
        missing = False
        if frames:
            try:
                with open(frames[-1], encoding="utf-8-sig") as f:
                    missing = "from __future__ import annotations" not in f.read()
            except OSError:
                missing = False
        if missing:
            where = os.path.relpath(frames[-1], root)
            return (f"{where} uses {error.name} in an annotation but imports it only under TYPE_CHECKING, "
                    "so it needs 'from __future__ import annotations' as its first import.")
    return message_of(error)


async def run(spec):
    global project_dir, copy_of, breakpoints, tracing
    project_dir = spec["projectDir"]
    copy_of = spec.get("copyOf")
    breakpoints = set(spec.get("breakpoints") or [])
    tracing = bool(spec.get("trace"))
    caps = build_capabilities(spec["capabilities"])
    root = spec["root"]
    sys.path.insert(0, root)

    if tracing:
        for index, block in enumerate(spec["blocks"]):
            try:
                fn = getattr(load(block["file"], root), block["functionName"])
            except Exception:
                # As in harness.cjs: a block that will not load goes unseen. If the run
                # needs it, importing the block being run reports the real reason.
                continue
            wrap_in_place(index, block["path"], fn)  # refuses loudly what it cannot watch

    module = load(spec["file"], root)
    block = getattr(module, spec["functionName"], None)
    if not inspect.iscoroutinefunction(block):
        raise LookupError(f"{os.path.basename(spec['file'])} has no async def called {spec['functionName']}.")
    return await block(spec["input"], caps)


def report(result):
    # A run that went past the most calls recorded carried on unseen, and whoever
    # reads the recording has to know it is not the whole run.
    truncated = {"truncated": True} if calls > MOST_CALLS_RECORDED else {}
    try:
        send({"type": "result", **result, "stores": stores, "logs": logs, **truncated})
    except (TypeError, ValueError, RecursionError) as error:
        send({"type": "result", "ok": False, "error": f"The block returned something that cannot be sent back: {message_of(error)}",
              "stores": stores, "logs": logs, **truncated})


def on_line(line):
    global breakpoints
    try:
        message = json.loads(line)
    except ValueError:
        return
    if message.get("type") == "resume":
        release_next(message.get("mode"))
    elif message.get("type") == "breakpoints":
        breakpoints = set(message.get("paths") or [])


def reader():
    for line in _control:
        loop.call_soon_threadsafe(on_line, line)
    # Stdin closed: Fragmentor has gone, or is done with this run.
    os._exit(0)


async def main():
    global loop
    loop = asyncio.get_running_loop()
    sys.modules["__fragmentor_harness__"] = sys.modules[__name__]
    line = _control.readline()
    if not line:
        os._exit(0)
    spec = json.loads(line)["spec"]
    threading.Thread(target=reader, daemon=True).start()
    try:
        result = {"ok": True, "output": await run(spec)}
    except BaseException as error:  # SystemExit from a block is a failure of the block, too
        result = {"ok": False, "error": explain(error, spec.get("root", ""))}
    report(result)
    _proto.flush()
    os._exit(0)


asyncio.run(main())
