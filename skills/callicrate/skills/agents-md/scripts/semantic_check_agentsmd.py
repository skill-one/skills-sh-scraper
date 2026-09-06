#!/usr/bin/env python3
"""Semantic checks for AGENTS.md guidance against a target repository."""

from __future__ import annotations

import argparse
import ast
import json
import re
import shlex
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path

import tomllib

LINK_PATTERN = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
INLINE_CODE_PATTERN = re.compile(r"`([^`]+)`")
FENCE_PATTERN = re.compile(r"^\s*(`{3,}|~{3,})\s*([^\s`]*)")

KNOWN_PATH_NAMES = {
    ".env",
    ".env.example",
    ".python-version",
    "AGENTS.md",
    "CHANGELOG.md",
    "Dockerfile",
    "Gemfile",
    "Makefile",
    "README.md",
    "build.gradle",
    "build.gradle.kts",
    "composer.json",
    "databricks.yml",
    "deno.json",
    "docker-compose.yml",
    "go.mod",
    "package.json",
    "pom.xml",
    "pyproject.toml",
    "requirements.txt",
    "setup.py",
    "tsconfig.json",
    "uv.lock",
}

KNOWN_PATH_SUFFIXES = {
    ".cfg",
    ".csproj",
    ".fsproj",
    ".ini",
    ".ipynb",
    ".js",
    ".json",
    ".jsx",
    ".lock",
    ".md",
    ".mjs",
    ".py",
    ".ps1",
    ".sql",
    ".toml",
    ".ts",
    ".tsx",
    ".yaml",
    ".yml",
}

COMMAND_LANGUAGES = {"bash", "console", "powershell", "ps1", "sh", "shell", "zsh"}
PARSEABLE_LANGUAGES = {"json", "python", "py", "toml"}

TOOL_CONFIGS = {
    "databricks": ("databricks.yml", ".databrickscfg"),
    "docker": ("Dockerfile", "docker-compose.yml", "compose.yml", "compose.yaml"),
    "go": ("go.mod",),
    "gradle": ("build.gradle", "build.gradle.kts", "gradlew", "gradlew.bat"),
    "mvn": ("pom.xml", "mvnw", "mvnw.cmd"),
    "node": ("package.json",),
    "npm": ("package.json",),
    "pnpm": ("package.json", "pnpm-lock.yaml"),
    "poetry": ("pyproject.toml", "poetry.lock"),
    "pytest": ("pyproject.toml", "pytest.ini", "conftest.py"),
    "python": ("pyproject.toml", "requirements.txt", "setup.py"),
    "python3": ("pyproject.toml", "requirements.txt", "setup.py"),
    "ruff": ("pyproject.toml", "ruff.toml", ".ruff.toml"),
    "uv": ("pyproject.toml", "uv.lock"),
    "yarn": ("package.json", "yarn.lock"),
}


@dataclass(frozen=True)
class Violation:
    path: Path
    line: int
    message: str
    code: str = "semantic-error"
    severity: str = "error"


@dataclass(frozen=True)
class CodeBlock:
    language: str
    start_line: int
    code: str


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def is_url(target: str) -> bool:
    return bool(re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", target))


def strip_fragment(target: str) -> str:
    return target.split("#", 1)[0]


def normalize_candidate_path(value: str) -> str:
    value = strip_fragment(value.strip().strip("'\"")).strip()
    return value.rstrip(".,;:")


def has_path_annotation(line: str) -> bool:
    lowered = line.lower()
    return any(
        marker in lowered
        for marker in (
            "planned",
            "external",
            "pattern",
            "does not exist",
            "not present",
            "do not use until implemented",
            "task-specific",
            "platform path",
        )
    )


def has_glob_pattern(value: str) -> bool:
    return any(character in value for character in ("*", "?"))


def has_angle_placeholder(value: str) -> bool:
    return "<" in value and ">" in value


def is_environment_or_platform_value(value: str) -> bool:
    if "$" in value or value.startswith("%"):
        return True
    if value.startswith("/"):
        return True
    if re.match(r"^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*", value):
        return True
    return False


def looks_like_path(value: str) -> bool:
    if not value or "[" in value or "]" in value or is_url(value):
        return False
    if any(character.isspace() for character in value):
        return False

    normalized = value.replace("\\", "/")
    name = Path(normalized).name
    if "/" in normalized or normalized.startswith("."):
        return True
    if name in KNOWN_PATH_NAMES:
        return True
    return Path(name).suffix in KNOWN_PATH_SUFFIXES


def resolve_repo_path(repo_root: Path, value: str) -> Path:
    normalized = normalize_candidate_path(value).replace("\\", "/")
    return (repo_root / normalized).resolve()


def is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def iter_markdown_links(path: Path, text: str) -> list[tuple[int, str]]:
    links: list[tuple[int, str]] = []
    for line_number, line in enumerate(text.splitlines(), start=1):
        for match in LINK_PATTERN.finditer(line):
            target = match.group(2).strip()
            if target:
                links.append((line_number, target))
    return links


def iter_inline_code(path: Path, text: str) -> list[tuple[int, str, str]]:
    spans: list[tuple[int, str, str]] = []
    in_fence = False
    fence_marker = ""

    for line_number, line in enumerate(text.splitlines(), start=1):
        fence_match = FENCE_PATTERN.match(line)
        if fence_match is not None:
            marker = fence_match.group(1)[0]
            if not in_fence:
                in_fence = True
                fence_marker = marker
            elif marker == fence_marker:
                in_fence = False
                fence_marker = ""
            continue
        if in_fence:
            continue
        for match in INLINE_CODE_PATTERN.finditer(line):
            spans.append((line_number, match.group(1).strip(), line))

    return spans


def iter_code_blocks(text: str) -> list[CodeBlock]:
    blocks: list[CodeBlock] = []
    in_fence = False
    fence_marker = ""
    language = ""
    start_line = 0
    lines: list[str] = []

    for line_number, line in enumerate(text.splitlines(), start=1):
        fence_match = FENCE_PATTERN.match(line)
        if fence_match is not None:
            marker = fence_match.group(1)[0]
            if not in_fence:
                in_fence = True
                fence_marker = marker
                language = fence_match.group(2).lower()
                start_line = line_number + 1
                lines = []
            elif marker == fence_marker:
                blocks.append(CodeBlock(language, start_line, "\n".join(lines)))
                in_fence = False
                fence_marker = ""
                language = ""
                start_line = 0
                lines = []
            continue
        if in_fence:
            lines.append(line)

    return blocks


def verify_path_reference(
    repo_root: Path,
    source_path: Path,
    line_number: int,
    value: str,
    *,
    line_text: str,
) -> list[Violation]:
    candidate = normalize_candidate_path(value)
    if not looks_like_path(candidate):
        return []
    if has_angle_placeholder(candidate) or is_environment_or_platform_value(candidate):
        return []
    if has_glob_pattern(candidate):
        matches = list(repo_root.glob(candidate.replace("\\", "/")))
        if matches or has_path_annotation(line_text):
            return []
        return [
            Violation(
                source_path,
                line_number,
                f"Path pattern has no matches in target repo: {candidate}",
                code="path-pattern",
            )
        ]

    resolved = resolve_repo_path(repo_root, candidate)
    if not is_within(resolved, repo_root):
        if has_path_annotation(line_text):
            return []
        return [
            Violation(source_path, line_number, f"Referenced path escapes repo root: {candidate}", code="path-escape")
        ]
    if not resolved.exists():
        if has_path_annotation(line_text):
            return []
        return [
            Violation(
                source_path,
                line_number,
                f"Referenced path does not exist in target repo: {candidate}",
                code="missing-path",
            )
        ]
    return []


def load_package_scripts(repo_root: Path) -> dict[str, str]:
    package_json = repo_root / "package.json"
    if not package_json.exists():
        return {}
    try:
        data = json.loads(read_text(package_json))
    except json.JSONDecodeError:
        return {}
    scripts = data.get("scripts")
    if not isinstance(scripts, dict):
        return {}
    return {str(name): str(command) for name, command in scripts.items()}


def load_make_targets(repo_root: Path) -> set[str]:
    targets: set[str] = set()
    makefile = repo_root / "Makefile"
    if not makefile.exists():
        return targets
    for line in read_text(makefile).splitlines():
        match = re.match(r"^([A-Za-z0-9_.-]+):", line)
        if match is not None:
            targets.add(match.group(1))
    return targets


def repo_has_tool_config(repo_root: Path, tool: str) -> bool:
    return any((repo_root / config).exists() for config in TOOL_CONFIGS.get(tool, ()))


def split_command_line(line: str) -> list[str]:
    command = line.strip()
    if not command or command.startswith("#") or "[" in command or "]" in command:
        return []
    command = re.split(r"\s+#", command, maxsplit=1)[0].strip()
    command = re.split(r"\s*(?:&&|\|\||;)\s*", command, maxsplit=1)[0].strip()
    if not command:
        return []

    try:
        parts = shlex.split(command, posix=False)
    except ValueError:
        return []

    while parts and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", parts[0]):
        parts.pop(0)
    return parts


def check_command(
    repo_root: Path,
    source_path: Path,
    line_number: int,
    parts: list[str],
    *,
    strict_command_tools: bool,
) -> list[Violation]:
    if not parts:
        return []

    raw_command = parts[0].strip("'\"")
    if raw_command.startswith(("./", ".\\")):
        command_path = resolve_repo_path(repo_root, raw_command)
        if not is_within(command_path, repo_root):
            return [
                Violation(
                    source_path,
                    line_number,
                    f"Command path escapes repo root: {raw_command}",
                    code="command-path-escape",
                )
            ]
        if not command_path.exists():
            return [
                Violation(
                    source_path, line_number, f"Command path does not exist: {raw_command}", code="missing-command-path"
                )
            ]
        return []

    command = Path(raw_command).name.lower()
    if command in {"cd", "copy", "del", "echo", "export", "mkdir", "set", "source"}:
        return []

    package_scripts = load_package_scripts(repo_root)
    make_targets = load_make_targets(repo_root)

    if command in {"npm", "pnpm"} and len(parts) >= 3 and parts[1] == "run":
        script = parts[2]
        if script not in package_scripts:
            return [
                Violation(
                    source_path,
                    line_number,
                    f"package.json has no script named {script!r}",
                    code="missing-package-script",
                )
            ]
        return []

    if command == "yarn" and len(parts) >= 2:
        script = parts[2] if len(parts) >= 3 and parts[1] == "run" else parts[1]
        if script not in package_scripts:
            return [
                Violation(
                    source_path,
                    line_number,
                    f"package.json has no script named {script!r}",
                    code="missing-package-script",
                )
            ]
        return []

    if command == "make" and len(parts) >= 2:
        target = parts[1]
        if target not in make_targets:
            return [
                Violation(
                    source_path, line_number, f"Makefile has no target named {target!r}", code="missing-make-target"
                )
            ]
        return []

    if repo_has_tool_config(repo_root, command):
        return []

    if not strict_command_tools:
        return []

    if shutil.which(command) is not None:
        return []

    return [
        Violation(
            source_path,
            line_number,
            f"Command tool {command!r} is not on PATH and no matching repo config was found",
            code="missing-command-tool",
        )
    ]


def check_commands(repo_root: Path, source_path: Path, text: str, *, strict_command_tools: bool) -> list[Violation]:
    violations: list[Violation] = []
    for block in iter_code_blocks(text):
        if block.language not in COMMAND_LANGUAGES:
            continue
        for offset, line in enumerate(block.code.splitlines()):
            parts = split_command_line(line)
            violations.extend(
                check_command(
                    repo_root,
                    source_path,
                    block.start_line + offset,
                    parts,
                    strict_command_tools=strict_command_tools,
                )
            )
    return violations


def check_parseable_examples(source_path: Path, text: str) -> list[Violation]:
    violations: list[Violation] = []
    for block in iter_code_blocks(text):
        if block.language not in PARSEABLE_LANGUAGES or "[" in block.code or "]" in block.code:
            continue
        try:
            if block.language in {"python", "py"}:
                ast.parse(block.code)
            elif block.language == "json":
                json.loads(block.code)
            elif block.language == "toml":
                tomllib.loads(block.code)
        except (SyntaxError, ValueError, tomllib.TOMLDecodeError) as exc:
            violations.append(
                Violation(
                    source_path,
                    block.start_line,
                    f"Invalid {block.language} code block: {exc}",
                    code="invalid-code-block",
                )
            )
    return violations


def check_references(repo_root: Path, source_path: Path, text: str) -> list[Violation]:
    violations: list[Violation] = []
    for line_number, target in iter_markdown_links(source_path, text):
        if is_url(target) or target.startswith("#"):
            continue
        target_path = normalize_candidate_path(target)
        resolved = (source_path.parent / strip_fragment(target_path)).resolve()
        if not is_within(resolved, repo_root):
            violations.append(
                Violation(source_path, line_number, f"Link escapes repo root: {target}", code="link-escape")
            )
        elif not resolved.exists():
            violations.append(
                Violation(source_path, line_number, f"Linked file does not exist: {target}", code="missing-link")
            )

    for line_number, value, line_text in iter_inline_code(source_path, text):
        violations.extend(verify_path_reference(repo_root, source_path, line_number, value, line_text=line_text))

    return violations


def collect_section_lines(text: str, target_headings: set[str]) -> list[tuple[int, str]]:
    lines: list[tuple[int, str]] = []
    active = False

    for line_number, line in enumerate(text.splitlines(), start=1):
        match = re.match(r"^(#{1,6})\s+(.+?)\s*$", line)
        if match is not None:
            active = match.group(2).strip().lower() in target_headings
            continue
        if active:
            lines.append((line_number, line))

    return lines


def find_nested_agents_scopes(repo_root: Path) -> list[str]:
    scopes: list[str] = []
    for path in repo_root.rglob("AGENTS.md"):
        if path.resolve() == (repo_root / "AGENTS.md").resolve():
            continue
        try:
            scope = path.parent.relative_to(repo_root).as_posix()
        except ValueError:
            continue
        if scope:
            scopes.append(scope.rstrip("/") + "/")
    return sorted(scopes)


def check_nested_scope_conflicts(repo_root: Path, agentsmd: Path, text: str) -> list[Violation]:
    if agentsmd.resolve() != (repo_root / "AGENTS.md").resolve():
        return []

    nested_scopes = find_nested_agents_scopes(repo_root)
    if not nested_scopes:
        return []

    violations: list[Violation] = []
    for line_number, line in collect_section_lines(text, {"project rules"}):
        for match in INLINE_CODE_PATTERN.finditer(line):
            value = normalize_candidate_path(match.group(1)).replace("\\", "/")
            if not any(value.startswith(scope) for scope in nested_scopes):
                continue
            if any(marker in line.lower() for marker in ("scope", "nested", "except")):
                continue
            violations.append(
                Violation(
                    agentsmd,
                    line_number,
                    "Root Project Rules should not duplicate narrower nested AGENTS.md scope guidance",
                    code="nested-scope-conflict",
                )
            )
    return violations


def semantic_check(
    repo_root: Path,
    agentsmd: Path,
    evidence: Path | None,
    *,
    strict_command_tools: bool,
) -> list[Violation]:
    agentsmd_text = read_text(agentsmd)
    violations: list[Violation] = []
    violations.extend(check_references(repo_root, agentsmd, agentsmd_text))
    violations.extend(check_nested_scope_conflicts(repo_root, agentsmd, agentsmd_text))
    violations.extend(check_commands(repo_root, agentsmd, agentsmd_text, strict_command_tools=strict_command_tools))
    violations.extend(check_parseable_examples(agentsmd, agentsmd_text))

    if evidence is not None:
        evidence_text = read_text(evidence)
        violations.extend(check_references(repo_root, evidence, evidence_text))
        violations.extend(check_commands(repo_root, evidence, evidence_text, strict_command_tools=strict_command_tools))
        violations.extend(check_parseable_examples(evidence, evidence_text))

    return violations


def main() -> int:
    parser = argparse.ArgumentParser(description="Run semantic checks for AGENTS.md guidance.")
    parser.add_argument("agentsmd", nargs="?", type=Path, help="Path to the AGENTS.md file to check")
    parser.add_argument("--agents-file", type=Path, help="Path to the AGENTS.md file to check")
    parser.add_argument(
        "--repo-root",
        type=Path,
        help="Target repository root. Defaults to the AGENTS.md parent directory.",
    )
    parser.add_argument(
        "--evidence",
        type=Path,
        help="Optional repo-owned evidence file to check when one is explicitly required.",
    )
    parser.add_argument(
        "--strict-command-tools",
        action="store_true",
        help="Also require referenced command tools to be available on PATH when no repo config proves them. Does not execute project commands.",
    )
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON findings.")
    args = parser.parse_args()

    if args.agentsmd is not None and args.agents_file is not None:
        parser.error("Provide AGENTS.md as either positional agentsmd or --agents-file, not both")
    agentsmd_arg = args.agents_file if args.agents_file is not None else args.agentsmd
    if agentsmd_arg is None:
        parser.error("Provide an AGENTS.md path with --agents-file or positional agentsmd")

    agentsmd = agentsmd_arg.resolve()
    repo_root = args.repo_root.resolve() if args.repo_root is not None else agentsmd.parent.resolve()

    if not repo_root.exists() or not repo_root.is_dir():
        print(f"Error: repo root is not a directory: {repo_root}", file=sys.stderr)
        return 2
    if not agentsmd.exists() or not agentsmd.is_file():
        print(f"Error: AGENTS.md path is not a file: {agentsmd}", file=sys.stderr)
        return 2

    evidence = args.evidence.resolve() if args.evidence is not None else None
    if evidence is not None and (not evidence.exists() or not evidence.is_file()):
        print(f"Error: evidence path is not a file: {evidence}", file=sys.stderr)
        return 2

    violations = semantic_check(repo_root, agentsmd, evidence, strict_command_tools=args.strict_command_tools)
    if violations:
        if args.json:
            print(
                json.dumps(
                    {
                        "status": "fail",
                        "findings": [
                            {
                                "severity": violation.severity,
                                "code": violation.code,
                                "path": str(violation.path),
                                "line": violation.line,
                                "message": violation.message,
                            }
                            for violation in violations
                        ],
                    },
                    indent=2,
                )
            )
        else:
            for violation in violations:
                print(f"{violation.path}:{violation.line}: {violation.message}")
        return 1

    if args.json:
        print(json.dumps({"status": "pass", "findings": []}, indent=2))
    else:
        print(f"AGENTS.md semantic check passed: {agentsmd}")
        if evidence is not None:
            print(f"Evidence semantic check passed: {evidence}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
