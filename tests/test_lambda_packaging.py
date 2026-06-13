"""Guard: every local module the Lambda entrypoints import (even via a lazy,
function-level import) is packaged by deploy/build_lambda.sh.

build_lambda.sh ships an EXPLICIT cp-list of modules, not the whole tree. A
module that's imported but left off the list 500s in production the moment that
import executes, while CI's tool-count smoke can still pass. This test walks the
real import graph from the two Lambda entrypoints and fails if anything in that
closure is missing from the package.
"""
import ast
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _packaged_modules() -> set[str]:
    sh = (ROOT / "deploy" / "build_lambda.sh").read_text()
    m = re.search(r'\ncp\s+(.*?)"\$BUILD/"', sh, re.DOTALL)
    assert m, 'could not find the `cp ... "$BUILD/"` line in build_lambda.sh'
    return set(re.findall(r"(\w+)\.py", m.group(1)))


def _local_modules() -> set[str]:
    return {p.stem for p in ROOT.glob("*.py")}


def _local_imports(module: str, local: set[str]) -> set[str]:
    tree = ast.parse((ROOT / f"{module}.py").read_text())
    found: set[str] = set()
    for node in ast.walk(tree):  # ast.walk catches imports inside functions too
        if isinstance(node, ast.Import):
            for alias in node.names:
                top = alias.name.split(".")[0]
                if top in local:
                    found.add(top)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            top = node.module.split(".")[0]
            if top in local:
                found.add(top)
    return found


def _closure(seeds: set[str], local: set[str]) -> set[str]:
    seen: set[str] = set()
    stack = list(seeds)
    while stack:
        mod = stack.pop()
        if mod in seen:
            continue
        seen.add(mod)
        stack.extend(_local_imports(mod, local) - seen)
    return seen


def test_lambda_entrypoint_modules_are_packaged():
    local = _local_modules()
    needed = _closure({"lambda_app", "sync"}, local)
    missing = needed - _packaged_modules()
    assert not missing, (
        "local modules imported by the Lambda but NOT in build_lambda.sh's "
        f"cp-list: {sorted(missing)}"
    )


def test_config_secrets_is_packaged():
    assert "config_secrets" in _packaged_modules()
