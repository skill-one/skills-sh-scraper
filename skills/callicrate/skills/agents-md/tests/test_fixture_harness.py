from __future__ import annotations

import subprocess
import sys
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parents[1]


def test_existing_fixture_checks_still_run() -> None:
    result = subprocess.run(
        [sys.executable, str(SKILL_ROOT / "scripts" / "run_agentsmd_fixture_checks.py")],
        cwd=SKILL_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert "PASS minimal-python structural" in result.stdout
    assert "PASS bad-stale-path semantic" in result.stdout


def test_template_hygiene_check_still_runs() -> None:
    result = subprocess.run(
        [sys.executable, str(SKILL_ROOT / "scripts" / "check_agentsmd_templates.py"), str(SKILL_ROOT)],
        cwd=SKILL_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert "template hygiene check passed" in result.stdout

