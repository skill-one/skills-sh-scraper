from __future__ import annotations

from pathlib import Path

import pytest

import validate_agentsmd


def write_agentsmd(tmp_path: Path, text: str) -> Path:
    path = tmp_path / "AGENTS.md"
    path.write_text(text, encoding="utf-8")
    return path


def test_standard_validation_rejects_unresolved_placeholders(tmp_path: Path) -> None:
    agentsmd = write_agentsmd(
        tmp_path,
        """# Example

## Context

- [Project Name]
""",
    )

    violations = validate_agentsmd.validate(agentsmd, mode="standard")

    assert any(violation.code == "placeholder" for violation in violations)


def test_create_standard_validation_rejects_h1_and_context_only(tmp_path: Path) -> None:
    agentsmd = write_agentsmd(
        tmp_path,
        """# Example

## Context

This repository exists.
""",
    )

    violations = validate_agentsmd.validate(agentsmd, mode="standard", intent="create")

    assert any(violation.code == "missing-required-section" for violation in violations)


def test_update_standard_validation_preserves_h1_and_context_only_structure(tmp_path: Path) -> None:
    agentsmd = write_agentsmd(
        tmp_path,
        """# Example

## Context

This repository exists.
""",
    )

    violations = validate_agentsmd.validate(agentsmd, mode="standard", intent="update")

    assert not violations


def test_update_standard_still_rejects_placeholders_and_generic_filler(tmp_path: Path) -> None:
    agentsmd = write_agentsmd(
        tmp_path,
        """# Example

## Context

TODO: replace this.

## Notes

- Follow best practices.
- Edit <path> with {{COMMAND}}.
<!-- template comment -->
""",
    )

    violations = validate_agentsmd.validate(agentsmd, mode="standard", intent="update")
    codes = {violation.code for violation in violations}

    assert "placeholder" in codes
    assert "generic-filler" in codes
    assert "template-comment" in codes


def test_length_budget_emits_warning_not_error_shape(tmp_path: Path) -> None:
    agentsmd = write_agentsmd(
        tmp_path,
        "# Example\n\n## Context\n\n" + "\n".join(f"- Line {index}" for index in range(700)),
    )

    violations = validate_agentsmd.validate(agentsmd, mode="standard", intent="review")

    assert any(
        violation.code == "length-budget" and violation.severity == "warning"
        for violation in violations
    )


def test_existing_good_fixture_passes_create_standard() -> None:
    fixture = Path(__file__).parent / "fixtures" / "minimal-python" / "AGENTS.md"

    violations = validate_agentsmd.validate(fixture, mode="standard", intent="create")

    assert not violations


def test_bad_placeholder_fixture_fails_with_clear_codes() -> None:
    fixture = Path(__file__).parent / "fixtures" / "bad-placeholders" / "AGENTS.md"

    violations = validate_agentsmd.validate(fixture, mode="standard", intent="update")

    assert any(violation.code == "placeholder" for violation in violations)


@pytest.mark.parametrize(
    "command",
    [
        "docker compose down -v",
        "aws s3 rm s3://example-bucket/data --recursive",
        "rm -fr build",
        "git clean -xfd",
    ],
)
def test_unsafe_command_detector_flags_destructive_variants(tmp_path: Path, command: str) -> None:
    agentsmd = write_agentsmd(
        tmp_path,
        f"""# Example

## Context

Destructive command example:

```bash
{command}
```
""",
    )

    violations = validate_agentsmd.validate(agentsmd, mode="standard")

    assert any(violation.code == "unsafe-command" for violation in violations)


def test_unsafe_command_detector_allows_benign_make_target(tmp_path: Path) -> None:
    agentsmd = write_agentsmd(
        tmp_path,
        """# Example

## Context

Local build command:

```bash
make target
```
""",
    )

    violations = validate_agentsmd.validate(agentsmd, mode="standard")

    assert not any(violation.code == "unsafe-command" for violation in violations)
