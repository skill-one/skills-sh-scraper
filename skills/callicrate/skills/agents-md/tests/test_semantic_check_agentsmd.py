from __future__ import annotations

from pathlib import Path

import pytest

import semantic_check_agentsmd


def write_repo_agentsmd(tmp_path: Path, text: str) -> Path:
    agentsmd = tmp_path / "AGENTS.md"
    agentsmd.write_text(text, encoding="utf-8")
    return agentsmd


def semantic_codes(repo_root: Path, agentsmd: Path) -> set[str]:
    violations = semantic_check_agentsmd.semantic_check(
        repo_root,
        agentsmd,
        None,
        strict_command_tools=False,
    )
    return {violation.code for violation in violations}


def test_semantic_check_reports_missing_inline_path(tmp_path: Path) -> None:
    agentsmd = write_repo_agentsmd(
        tmp_path,
        """# Example

## Context

- Read `docs/missing.md` before changing workflows.
""",
    )

    assert "missing-path" in semantic_codes(tmp_path, agentsmd)


@pytest.mark.xfail(reason="Known gap: absolute platform paths are skipped before repo-escape checking.")
def test_semantic_check_rejects_etc_passwd_inline_path(tmp_path: Path) -> None:
    # TODO(issue): Treat absolute inline paths as repo escapes unless explicitly marked platform paths.
    agentsmd = write_repo_agentsmd(
        tmp_path,
        """# Example

## Context

- Do not rely on `/etc/passwd` for local repository behavior.
""",
    )

    assert "path-escape" in semantic_codes(tmp_path, agentsmd)


@pytest.mark.xfail(reason="Known gap: one Planned annotation suppresses every path finding on the same line.")
def test_semantic_check_reports_missing_path_even_when_other_path_is_planned(tmp_path: Path) -> None:
    # TODO(issue): Apply Planned/external annotations to the annotated path, not the entire line.
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "real.md").write_text("real\n", encoding="utf-8")
    agentsmd = write_repo_agentsmd(
        tmp_path,
        """# Example

## Context

- `docs/planned.md` is Planned, but `docs/missing.md` must already exist.
""",
    )

    assert "missing-path" in semantic_codes(tmp_path, agentsmd)


@pytest.mark.xfail(reason="Known gap: parseable code blocks containing brackets are skipped entirely.")
def test_semantic_check_reports_invalid_python_containing_bracket(tmp_path: Path) -> None:
    # TODO(issue): Parse examples with brackets and report syntax errors instead of skipping.
    agentsmd = write_repo_agentsmd(
        tmp_path,
        """# Example

## Context

```python
value = [
```
""",
    )

    assert "invalid-code-block" in semantic_codes(tmp_path, agentsmd)

