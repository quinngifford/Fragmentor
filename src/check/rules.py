"""Form rules for bound Python code, run by `fragmentor check`.

Reads a JSON spec on stdin -- {"project": <absolute dir>, "blocks": [{"file":
<project-relative .py>, "function": <name>, "types": [Input, Caps, Output]}]}
-- and prints a JSON list of problems, each {"file", "line", "column",
"message"}. Every rule here is an honesty check, not a sandbox: it holds the
file to the form the harness and the typechecker rely on, and refuses what
they could not see through. pyright cannot enforce these, so they live here.

find_spec is only ever called on top-level names, so no package's __init__ is
ever run by checking.
"""

import ast
import json
import re
import sys
import tokenize
from importlib.util import find_spec
from pathlib import Path

# The standard library a block may use: modules that only compute. Reading
# files, the network, processes and the interpreter itself come through
# capabilities instead, exactly as TypeScript blocks have no Node built-ins.
# asyncio is here because every block is an async function; that it can reach
# further is an accepted limit, as installed packages can.
ALLOWED = {
    "__future__", "abc", "array", "asyncio", "base64", "binascii", "bisect", "calendar", "cmath",
    "collections", "contextlib", "contextvars", "copy", "dataclasses", "datetime", "decimal",
    "difflib", "enum", "fractions", "functools", "graphlib", "hashlib", "heapq", "hmac",
    "itertools", "json", "keyword", "math", "operator", "random", "re", "secrets", "statistics",
    "string", "textwrap", "time", "types", "typing", "unicodedata", "uuid", "zoneinfo",
}

# pyright honours '# pyright: ignore' and '# pyright: rule=false' even with
# enableTypeIgnoreComments off, so the comments themselves are refused.
PRAGMA = re.compile(r"#\s*pyright\s*:")

IO_BUILTINS = ("open", "print", "input")


def is_type_checking(test):
    """Whether an `if` guards on TYPE_CHECKING, plainly written."""
    return (isinstance(test, ast.Name) and test.id == "TYPE_CHECKING") or (
        isinstance(test, ast.Attribute) and test.attr == "TYPE_CHECKING"
    )


def installed(top):
    """Whether a top-level name resolves with the project off sys.path: True, False, or None for cannot say."""
    try:
        return find_spec(top) is not None
    except Exception:
        # `__main__`, and anything else the finder refuses to speak about.
        return None


def init_has_code(path):
    """Whether a package's __init__.py holds anything beyond a docstring."""
    try:
        tree = ast.parse(path.read_text(encoding="utf-8-sig"))
    except (OSError, SyntaxError, ValueError):
        return True
    body = tree.body
    if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
        body = body[1:]
    return len(body) > 0


def bound_names(tree):
    """Every name the file itself binds, anywhere in it."""
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            names.add(node.id)
        elif isinstance(node, ast.arg):
            names.add(node.arg)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.alias):
            names.add((node.asname or node.name).split(".")[0])
        elif isinstance(node, ast.ExceptHandler) and node.name:
            names.add(node.name)
    return names


def annotation_name(node):
    """An annotation as the one name it is, also when written as a string."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value.strip()
    return None


def check_function(tree, block, at):
    """The block's function: top level, undecorated, async, annotated with its contract."""
    input_name, caps_name, output_name = block["types"]
    wanted = block["function"]
    found = next(
        (n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == wanted),
        None,
    )
    if found is None:
        return [at(1, 1, f"does not define {wanted} at the top level of the file, where Fragmentor can import it from")]
    problems = []
    if not isinstance(found, ast.AsyncFunctionDef):
        problems.append(at(found.lineno, found.col_offset + 1, f"{wanted} must be `async def`, because Fragmentor awaits every block it calls"))
    if found.decorator_list:
        problems.append(at(found.lineno, found.col_offset + 1, f"{wanted} must not be decorated, because Fragmentor calls the function exactly as it is written"))
    args = found.args
    plain = args.posonlyargs + args.args
    if len(plain) != 2 or args.vararg or args.kwonlyargs or args.kwarg:
        problems.append(at(found.lineno, found.col_offset + 1, f"{wanted} must take exactly a value and `caps`, which is how every block is called"))
    else:
        for arg, expected in zip(plain, (input_name, caps_name)):
            if annotation_name(arg.annotation) != expected:
                problems.append(at(arg.lineno, arg.col_offset + 1, f"{wanted}'s `{arg.arg}` must be annotated {expected}, from the block's contract"))
    if annotation_name(found.returns) != output_name:
        problems.append(at(found.lineno, found.col_offset + 1, f"{wanted} must be annotated `-> {output_name}`, from the block's contract"))
    return problems


def check_file(project, block, bound_files):
    file = block["file"]
    full = Path(project, *file.split("/"))
    problems = []

    def at(line, column, message):
        return {"file": file, "line": line, "column": column, "message": f"{file} {message}."}

    try:
        # utf-8-sig, because the import system itself accepts a BOM.
        source = full.read_text(encoding="utf-8-sig")
        tree = ast.parse(source)
    except SyntaxError as error:
        return [at(error.lineno or 1, error.offset or 1, f"is not valid Python: {error.msg}")]
    except (OSError, ValueError, UnicodeDecodeError) as error:
        return [at(1, 1, f"could not be read as Python source: {error}")]

    with tokenize.open(full) as handle:
        for token in tokenize.generate_tokens(handle.readline):
            if token.type == tokenize.COMMENT and PRAGMA.search(token.string):
                problems.append(at(token.start[0], token.start[1] + 1, "carries a `# pyright:` comment, which would quietly turn checking off; take it out"))

    problems.extend(check_function(tree, block, at))

    has_future = any(
        isinstance(node, ast.ImportFrom) and node.module == "__future__"
        and any(alias.name == "annotations" for alias in node.names)
        for node in tree.body
    )
    # Only the guard's own body is type-only: its else branch is exactly the
    # code that runs.
    guarded = {
        each
        for node in tree.body
        if isinstance(node, ast.If) and is_type_checking(node.test)
        for child in node.body
        for each in ast.walk(child)
    }

    imports = [node for node in ast.walk(tree) if isinstance(node, (ast.Import, ast.ImportFrom))]
    if any(node in guarded for node in imports) and not has_future:
        problems.append(at(1, 1, "imports under TYPE_CHECKING but has no `from __future__ import annotations`, so its annotations would name things that are not there when it runs"))

    binds = bound_names(tree)
    for name in IO_BUILTINS:
        if name in binds:
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Name) and node.id == name and isinstance(node.ctx, ast.Load):
                problems.append(at(node.lineno, node.col_offset + 1, f"uses `{name}`; a block reads, writes and reports through its capabilities instead"))
                break

    for node in imports:
        if isinstance(node, ast.ImportFrom) and node.level > 0:
            problems.append(at(node.lineno, node.col_offset + 1, "imports relatively; Fragmentor can only follow imports written from the project root"))
            continue
        modules = [node.module] if isinstance(node, ast.ImportFrom) else [alias.name for alias in node.names]
        for module in modules:
            if module is None or module == "__future__":
                continue
            top = module.split(".")[0]
            if top == "blocks":
                # The contract and blocks.capabilities are types only, and a
                # run copy holds neither, so importing one for real would fail.
                if node not in guarded:
                    problems.append(at(node.lineno, node.col_offset + 1, f"imports {module} outside `if TYPE_CHECKING:`, and contracts are types only; move the import under the guard"))
                continue
            if node in guarded:
                continue
            local = local_target(project, module)
            if local is not None:
                problems.extend(check_local(project, module, local, bound_files, node, at))
            elif top in sys.stdlib_module_names:
                if top not in ALLOWED:
                    problems.append(at(node.lineno, node.col_offset + 1, f"imports `{top}`, which reaches outside the block; use a capability instead"))
            elif installed(top) is False:
                problems.append(at(node.lineno, node.col_offset + 1, f"imports `{top}`, which is not installed in the project"))
    return problems


def local_target(project, module):
    """The file or package a dotted module names inside the project, or None."""
    base = Path(project, *module.split("."))
    if base.with_suffix(".py").is_file():
        return base.with_suffix(".py")
    if base.is_dir():
        return base
    return None


def check_local(project, module, target, bound_files, node, at):
    problems = []
    top = module.split(".")[0]
    # The same top-level name resolving somewhere else too means Python may
    # not load the project's own folder, depending on how it is started.
    if installed(top) is True:
        problems.append(at(node.lineno, node.col_offset + 1, f"imports `{top}`, a folder of the project that is also the name of something installed, so which one loads depends on how Python is started; rename the folder"))
        return problems
    # Importing a package runs every __init__.py on the way, outside any
    # block, so those files may hold nothing.
    walked = Path(project)
    for part in module.split(".")[:-1] if target.suffix == ".py" else module.split("."):
        walked = walked / part
        init = walked / "__init__.py"
        if init.is_file() and init_has_code(init):
            rel = init.relative_to(project).as_posix()
            problems.append(at(node.lineno, node.col_offset + 1, f"imports through {rel}, which holds code that would run outside any block; empty it"))
    if target.suffix == ".py":
        rel = target.relative_to(project).as_posix()
        if rel not in bound_files:
            problems.append(at(node.lineno, node.col_offset + 1, f"imports {rel}, which is not the code of a block held to its contract, so nothing checks what it does"))
    else:
        # A bare package import: whatever is used off it cannot be followed.
        problems.append(at(node.lineno, node.col_offset + 1, f"imports the folder {module} rather than a block's own file; import the function from its file"))
    return problems


def main():
    # The spec arrives as UTF-8 whatever the console's own encoding thinks.
    spec = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    project = spec["project"]
    bound_files = {block["file"] for block in spec["blocks"]}
    problems = []
    for block in spec["blocks"]:
        try:
            problems.extend(check_file(project, block, bound_files))
        except Exception as error:
            # One file the rules crashed on is that file's problem, never a
            # pass that silently told us nothing about the others.
            problems.append({
                "file": block["file"], "line": 1, "column": 1,
                "message": f"{block['file']} could not be checked: {type(error).__name__}: {error}.",
            })
    print(json.dumps(problems))


if __name__ == "__main__":
    main()
