#!/usr/bin/env python3
"""Run fixture checks for the agents-md validators."""

from __future__ import annotations

import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class FixtureCase:
    name: str
    command: list[str]
    expected_exit: int
    expected_json_status: str | None = None


def run_case(case: FixtureCase) -> bool:
    result = subprocess.run(case.command, capture_output=True, text=True, check=False)
    if result.returncode == case.expected_exit:
        if case.expected_json_status is not None:
            try:
                payload = json.loads(result.stdout)
            except json.JSONDecodeError as exc:
                print(f"FAIL {case.name}: invalid JSON output: {exc}")
                if result.stdout.strip():
                    print(result.stdout.strip())
                if result.stderr.strip():
                    print(result.stderr.strip())
                return False
            if payload.get("status") != case.expected_json_status:
                print(
                    f"FAIL {case.name}: expected JSON status {case.expected_json_status!r}, "
                    f"got {payload.get('status')!r}"
                )
                return False
        print(f"PASS {case.name}")
        return True

    print(f"FAIL {case.name}: expected exit {case.expected_exit}, got {result.returncode}")
    if result.stdout.strip():
        print(result.stdout.strip())
    if result.stderr.strip():
        print(result.stderr.strip())
    return False


def main() -> int:
    skill_dir = Path(__file__).resolve().parents[1]
    fixtures_dir = skill_dir / "tests" / "fixtures"
    validate_script = skill_dir / "scripts" / "validate_agentsmd.py"
    semantic_script = skill_dir / "scripts" / "semantic_check_agentsmd.py"

    minimal_repo = fixtures_dir / "minimal-python"
    stale_repo = fixtures_dir / "bad-stale-path"
    contract_repo = fixtures_dir / "contract-bearing"
    operational_repo = fixtures_dir / "operational"
    bad_broken_link_repo = fixtures_dir / "bad-broken-link"
    dynamic_paths_repo = fixtures_dir / "dynamic-paths"
    bad_nested_conflict_repo = fixtures_dir / "bad-nested-conflict"

    cases = [
        FixtureCase(
            name="minimal-python structural",
            command=[
                sys.executable,
                str(validate_script),
                "--repo-root",
                str(minimal_repo),
                "--agents-file",
                str(minimal_repo / "AGENTS.md"),
                "--mode",
                "standard",
            ],
            expected_exit=0,
        ),
        FixtureCase(
            name="minimal-python semantic",
            command=[
                sys.executable,
                str(semantic_script),
                "--repo-root",
                str(minimal_repo),
                "--agents-file",
                str(minimal_repo / "AGENTS.md"),
            ],
            expected_exit=0,
        ),
        FixtureCase(
            name="minimal-python structural json",
            command=[
                sys.executable,
                str(validate_script),
                "--repo-root",
                str(minimal_repo),
                "--agents-file",
                str(minimal_repo / "AGENTS.md"),
                "--mode",
                "standard",
                "--json",
            ],
            expected_exit=0,
            expected_json_status="pass",
        ),
        FixtureCase(
            name="contract-bearing structural",
            command=[
                sys.executable,
                str(validate_script),
                "--repo-root",
                str(contract_repo),
                "--agents-file",
                str(contract_repo / "AGENTS.md"),
                "--mode",
                "standard",
            ],
            expected_exit=0,
        ),
        FixtureCase(
            name="contract-bearing semantic",
            command=[
                sys.executable,
                str(semantic_script),
                "--repo-root",
                str(contract_repo),
                "--agents-file",
                str(contract_repo / "AGENTS.md"),
            ],
            expected_exit=0,
        ),
        FixtureCase(
            name="operational structural",
            command=[
                sys.executable,
                str(validate_script),
                "--repo-root",
                str(operational_repo),
                "--agents-file",
                str(operational_repo / "AGENTS.md"),
                "--mode",
                "standard",
            ],
            expected_exit=0,
        ),
        FixtureCase(
            name="operational semantic",
            command=[
                sys.executable,
                str(semantic_script),
                "--repo-root",
                str(operational_repo),
                "--agents-file",
                str(operational_repo / "AGENTS.md"),
            ],
            expected_exit=0,
        ),
        FixtureCase(
            name="bad-placeholders structural",
            command=[
                sys.executable,
                str(validate_script),
                "--agents-file",
                str(fixtures_dir / "bad-placeholders" / "AGENTS.md"),
                "--mode",
                "standard",
            ],
            expected_exit=1,
        ),
        FixtureCase(
            name="bad-unsafe-command structural",
            command=[
                sys.executable,
                str(validate_script),
                "--agents-file",
                str(fixtures_dir / "bad-unsafe-command" / "AGENTS.md"),
                "--mode",
                "standard",
            ],
            expected_exit=1,
        ),
        FixtureCase(
            name="good-maintainer-only-command structural",
            command=[
                sys.executable,
                str(validate_script),
                "--agents-file",
                str(fixtures_dir / "good-maintainer-only-command" / "AGENTS.md"),
                "--mode",
                "standard",
            ],
            expected_exit=0,
        ),
        FixtureCase(
            name="bad-stale-path semantic",
            command=[
                sys.executable,
                str(semantic_script),
                "--repo-root",
                str(stale_repo),
                "--agents-file",
                str(stale_repo / "AGENTS.md"),
            ],
            expected_exit=1,
        ),
        FixtureCase(
            name="bad-broken-link semantic json",
            command=[
                sys.executable,
                str(semantic_script),
                "--repo-root",
                str(bad_broken_link_repo),
                "--agents-file",
                str(bad_broken_link_repo / "AGENTS.md"),
                "--json",
            ],
            expected_exit=1,
            expected_json_status="fail",
        ),
        FixtureCase(
            name="dynamic-paths semantic",
            command=[
                sys.executable,
                str(semantic_script),
                "--repo-root",
                str(dynamic_paths_repo),
                "--agents-file",
                str(dynamic_paths_repo / "AGENTS.md"),
            ],
            expected_exit=0,
        ),
        FixtureCase(
            name="bad-nested-conflict semantic",
            command=[
                sys.executable,
                str(semantic_script),
                "--repo-root",
                str(bad_nested_conflict_repo),
                "--agents-file",
                str(bad_nested_conflict_repo / "AGENTS.md"),
            ],
            expected_exit=1,
        ),
    ]

    results = [run_case(case) for case in cases]
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
