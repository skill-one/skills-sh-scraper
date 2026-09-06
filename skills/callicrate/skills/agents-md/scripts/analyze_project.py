#!/usr/bin/env python3
"""Analyze a project to bootstrap AGENTS.md creation.

This script scans a project directory to identify:
- Languages and frameworks from config files
- Linter/formatter configurations
- Naming conventions from source files
- Testing patterns from test files
- Domain terminology from comments and docs

Usage:
    python analyze_project.py /path/to/project
    python analyze_project.py /path/to/project --output json
    python analyze_project.py /path/to/project --output markdown

Output:
    Structured report suitable for AGENTS.md generation.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import re
import sys
import tomllib
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

# =============================================================================
# Configuration File Detection
# =============================================================================

CONFIG_FILES: dict[str, dict[str, Any]] = {
    # Python
    "pyproject.toml": {"language": "Python", "frameworks": ["detect"]},
    "setup.py": {"language": "Python"},
    "requirements.txt": {"language": "Python"},
    "Pipfile": {"language": "Python"},
    "poetry.lock": {"language": "Python", "tools": ["Poetry"]},
    "uv.lock": {"language": "Python", "tools": ["uv"]},
    # JavaScript/TypeScript
    "package.json": {"language": "JavaScript/TypeScript", "frameworks": ["detect"]},
    "tsconfig.json": {"language": "TypeScript"},
    "deno.json": {"language": "TypeScript", "runtime": "Deno"},
    # Rust
    "Cargo.toml": {"language": "Rust"},
    # Go
    "go.mod": {"language": "Go"},
    # Java/Kotlin
    "pom.xml": {"language": "Java", "tools": ["Maven"]},
    "build.gradle": {"language": "Java/Kotlin", "tools": ["Gradle"]},
    "build.gradle.kts": {"language": "Kotlin", "tools": ["Gradle"]},
    # .NET
    "*.csproj": {"language": "C#"},
    "*.fsproj": {"language": "F#"},
    # Ruby
    "Gemfile": {"language": "Ruby"},
    # PHP
    "composer.json": {"language": "PHP"},
    # Databricks
    "databricks.yml": {"platform": "Databricks", "tools": ["Asset Bundles"]},
}

LOCKFILES: dict[str, str] = {
    "package-lock.json": "npm",
    "npm-shrinkwrap.json": "npm",
    "pnpm-lock.yaml": "pnpm",
    "yarn.lock": "Yarn",
    "bun.lock": "Bun",
    "bun.lockb": "Bun",
    "uv.lock": "uv",
    "poetry.lock": "Poetry",
    "Pipfile.lock": "Pipenv",
    "Cargo.lock": "Cargo",
    "go.sum": "Go modules",
    "Gemfile.lock": "Bundler",
    "composer.lock": "Composer",
}

MONOREPO_PACKAGE_CONFIG_PATTERNS = [
    "packages/*/package.json",
    "apps/*/package.json",
    "services/*/package.json",
]

LINTER_FILES: dict[str, dict[str, str]] = {
    # Python
    ".ruff.toml": {"tool": "Ruff", "language": "Python"},
    "ruff.toml": {"tool": "Ruff", "language": "Python"},
    ".pylintrc": {"tool": "Pylint", "language": "Python"},
    "pyrightconfig.json": {"tool": "Pyright", "language": "Python"},
    "mypy.ini": {"tool": "mypy", "language": "Python"},
    ".flake8": {"tool": "Flake8", "language": "Python"},
    # JavaScript/TypeScript
    ".eslintrc": {"tool": "ESLint", "language": "JavaScript/TypeScript"},
    ".eslintrc.js": {"tool": "ESLint", "language": "JavaScript/TypeScript"},
    ".eslintrc.json": {"tool": "ESLint", "language": "JavaScript/TypeScript"},
    "eslint.config.js": {"tool": "ESLint", "language": "JavaScript/TypeScript"},
    "eslint.config.mjs": {"tool": "ESLint", "language": "JavaScript/TypeScript"},
    # Formatters
    ".prettierrc": {"tool": "Prettier", "language": "JavaScript/TypeScript"},
    ".prettierrc.json": {"tool": "Prettier", "language": "JavaScript/TypeScript"},
    # SQL
    ".sqlfluff": {"tool": "SQLFluff", "language": "SQL"},
    # Rust
    "rustfmt.toml": {"tool": "rustfmt", "language": "Rust"},
    "clippy.toml": {"tool": "Clippy", "language": "Rust"},
}

TEST_PATTERNS: dict[str, dict[str, str]] = {
    "pytest.ini": {"framework": "pytest", "language": "Python"},
    "conftest.py": {"framework": "pytest", "language": "Python"},
    "jest.config.js": {"framework": "Jest", "language": "JavaScript/TypeScript"},
    "jest.config.ts": {"framework": "Jest", "language": "TypeScript"},
    "vitest.config.ts": {"framework": "Vitest", "language": "TypeScript"},
    "vitest.config.js": {"framework": "Vitest", "language": "JavaScript"},
    "playwright.config.ts": {"framework": "Playwright", "language": "TypeScript"},
    "cypress.config.ts": {"framework": "Cypress", "language": "TypeScript"},
}

SKIP_DIR_NAMES: set[str] = {
    ".git",
    ".gradle",
    ".hg",
    ".idea",
    ".mypy_cache",
    ".nox",
    ".pytest_cache",
    ".ruff_cache",
    ".svn",
    ".tox",
    ".venv",
    ".vscode",
    "__pycache__",
    "build",
    "coverage",
    "dist",
    "env",
    "generated",
    "htmlcov",
    "node_modules",
    "out",
    "site-packages",
    "target",
    "tmp",
    "vendor",
    "vendors",
    "venv",
}

MAX_NAMING_FILES = 10
MAX_PATTERN_FILES = 20
DEFAULT_MAX_FILES = 200
SOURCE_SUFFIXES = {
    ".cs",
    ".fs",
    ".go",
    ".java",
    ".js",
    ".jsx",
    ".kt",
    ".php",
    ".py",
    ".rb",
    ".rs",
    ".sql",
    ".ts",
    ".tsx",
}
GENERATED_BOUNDARY_DIR_NAMES = {
    "generated",
    "gen",
    "vendor",
    "vendors",
    "migrations",
    "schema",
    "schemas",
}


# =============================================================================
# Data Classes
# =============================================================================


@dataclass
class ProjectAnalysis:
    """Complete project analysis result."""

    schema_version: str = "1.1"
    project_path: str = ""
    agents_files: list[str] = field(default_factory=list)
    languages: list[str] = field(default_factory=list)
    frameworks: list[str] = field(default_factory=list)
    tools: list[str] = field(default_factory=list)
    package_managers: list[dict[str, str]] = field(default_factory=list)
    command_inventory: list[dict[str, str]] = field(default_factory=list)
    python_version_hints: list[dict[str, str]] = field(default_factory=list)
    linters: list[dict[str, str]] = field(default_factory=list)
    formatters: list[dict[str, str]] = field(default_factory=list)
    test_frameworks: list[dict[str, str]] = field(default_factory=list)
    naming_conventions: dict[str, str] = field(default_factory=dict)
    config_files: list[str] = field(default_factory=list)
    generated_candidates: list[str] = field(default_factory=list)
    source_files_sampled: int = 0
    detected_patterns: list[str] = field(default_factory=list)
    detected_facts: list[dict[str, Any]] = field(default_factory=list)
    suggestions: list[str] = field(default_factory=list)
    uncertainty_items: list[dict[str, Any]] = field(default_factory=list)


# =============================================================================
# Analysis Functions
# =============================================================================


def iter_project_files(
    project_path: Path,
    *,
    suffixes: set[str] | None = None,
    names: set[str] | None = None,
    max_files: int | None = None,
    max_depth: int | None = None,
    include_patterns: list[str] | None = None,
    exclude_patterns: list[str] | None = None,
    follow_symlinks: bool = False,
) -> list[Path]:
    """Return a bounded sample of files while pruning generated directories."""
    matches: list[Path] = []

    for root, dirnames, filenames in os.walk(project_path, followlinks=follow_symlinks):
        root_path = Path(root)
        if max_depth is not None:
            depth = len(root_path.relative_to(project_path).parts) if root_path != project_path else 0
            if depth >= max_depth:
                dirnames[:] = []
        dirnames[:] = [dirname for dirname in dirnames if dirname not in SKIP_DIR_NAMES]

        for filename in filenames:
            path = root_path / filename
            relative_path = path.relative_to(project_path).as_posix()
            if include_patterns and not any(fnmatch.fnmatch(relative_path, pattern) for pattern in include_patterns):
                continue
            if exclude_patterns and any(fnmatch.fnmatch(relative_path, pattern) for pattern in exclude_patterns):
                continue
            if suffixes is not None and path.suffix not in suffixes:
                continue
            if names is not None and filename not in names:
                continue

            matches.append(path)
            if max_files is not None and len(matches) >= max_files:
                return matches

    return matches


def find_agents_files(project_path: Path) -> list[str]:
    """Find root and nested AGENTS.md files."""
    paths = iter_project_files(project_path, names={"AGENTS.md"}, max_files=100)
    return sorted(path.relative_to(project_path).as_posix() for path in paths)


def find_generated_candidates(project_path: Path, *, max_depth: int | None = None) -> list[str]:
    """Find directory names that often define generated, vendored, or append-only boundaries."""
    candidates: list[str] = []

    for root, dirnames, _ in os.walk(project_path):
        root_path = Path(root)
        if max_depth is not None:
            depth = len(root_path.relative_to(project_path).parts) if root_path != project_path else 0
            if depth >= max_depth:
                dirnames[:] = []
        dirnames[:] = [
            dirname for dirname in dirnames if dirname not in SKIP_DIR_NAMES or dirname in GENERATED_BOUNDARY_DIR_NAMES
        ]

        for dirname in dirnames:
            if dirname.lower() not in GENERATED_BOUNDARY_DIR_NAMES:
                continue
            path = root_path / dirname
            candidates.append(path.relative_to(project_path).as_posix() + "/")

    return sorted(set(candidates))


def dedupe_paths(paths: list[Path]) -> list[Path]:
    """Return paths in stable order without duplicates."""
    seen: set[Path] = set()
    deduped: list[Path] = []
    for path in paths:
        normalized = path.resolve()
        if normalized in seen:
            continue
        seen.add(normalized)
        deduped.append(path)
    return sorted(deduped, key=lambda path: path.as_posix())


def find_config_files(project_path: Path, *, max_files: int = DEFAULT_MAX_FILES) -> dict[str, list[Path]]:
    """Find all configuration files in the project."""
    found: dict[str, list[Path]] = {
        "language_configs": [],
        "linter_configs": [],
        "test_configs": [],
        "lockfiles": [],
    }

    recursive_language_names = {
        name for name in CONFIG_FILES if "*" not in name and name not in {"requirements.txt", "Pipfile"}
    }
    recursive_language_names.update(LOCKFILES)
    found["language_configs"].extend(
        iter_project_files(project_path, names=recursive_language_names, max_files=max_files)
    )

    for pattern in MONOREPO_PACKAGE_CONFIG_PATTERNS:
        found["language_configs"].extend(project_path.glob(pattern))

    for config_file, _ in CONFIG_FILES.items():
        if "*" in config_file:
            pattern = config_file
            matches = list(project_path.glob(pattern))
            found["language_configs"].extend(matches)
        else:
            path = project_path / config_file
            if path.exists():
                found["language_configs"].append(path)

    for linter_file in LINTER_FILES:
        path = project_path / linter_file
        if path.exists():
            found["linter_configs"].append(path)

    for test_file in TEST_PATTERNS:
        if test_file.endswith(".py"):
            found["test_configs"].extend(iter_project_files(project_path, names={test_file}, max_files=1))
        else:
            path = project_path / test_file
            if path.exists():
                found["test_configs"].append(path)

    found["lockfiles"].extend(iter_project_files(project_path, names=set(LOCKFILES), max_files=max_files))

    for key, paths in found.items():
        found[key] = dedupe_paths(paths)

    return found


def detect_languages_and_frameworks(
    config_files: list[Path],
) -> tuple[set[str], set[str], set[str]]:
    """Detect languages and frameworks from config files."""
    languages: set[str] = set()
    frameworks: set[str] = set()
    tools: set[str] = set()

    for config_path in config_files:
        filename = config_path.name

        for pattern, info in CONFIG_FILES.items():
            if "*" in pattern:
                if fnmatch.fnmatch(filename, pattern):
                    if "language" in info:
                        languages.add(info["language"])
            elif filename == pattern:
                if "language" in info:
                    languages.add(info["language"])
                if "tools" in info:
                    tools.update(info["tools"])
                if "platform" in info:
                    frameworks.add(info["platform"])

        # Deep inspection for specific files
        if filename == "pyproject.toml":
            try:
                content = config_path.read_text()
                if "fastapi" in content.lower():
                    frameworks.add("FastAPI")
                if "django" in content.lower():
                    frameworks.add("Django")
                if "flask" in content.lower():
                    frameworks.add("Flask")
                if "pyspark" in content.lower() or "databricks" in content.lower():
                    frameworks.add("PySpark")
                if "torch" in content.lower() or "pytorch" in content.lower():
                    frameworks.add("PyTorch")
                if "transformers" in content.lower():
                    frameworks.add("HuggingFace Transformers")
                if "mlflow" in content.lower():
                    tools.add("MLflow")
                if "[tool.ruff]" in content:
                    tools.add("Ruff")
                if "[tool.black]" in content:
                    tools.add("Black")
                if "[tool.pytest" in content:
                    tools.add("pytest")
            except Exception:
                pass

        if filename == "package.json":
            try:
                content = config_path.read_text()
                data = json.loads(content)
                deps = {
                    **data.get("dependencies", {}),
                    **data.get("devDependencies", {}),
                }
                if "react" in deps:
                    frameworks.add("React")
                if "next" in deps:
                    frameworks.add("Next.js")
                if "vue" in deps:
                    frameworks.add("Vue")
                if "express" in deps:
                    frameworks.add("Express")
                if "fastify" in deps:
                    frameworks.add("Fastify")
                if "vitest" in deps:
                    tools.add("Vitest")
                if "jest" in deps:
                    tools.add("Jest")
                if "typescript" in deps:
                    languages.add("TypeScript")
            except Exception:
                pass

    return languages, frameworks, tools


def detect_linters_and_formatters(
    linter_configs: list[Path],
) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    """Detect linters and formatters from config files."""
    linters: list[dict[str, str]] = []
    formatters: list[dict[str, str]] = []

    formatters_set = {"Prettier", "Black", "rustfmt"}

    for config_path in linter_configs:
        filename = config_path.name
        if filename in LINTER_FILES:
            info = LINTER_FILES[filename]
            entry = {"tool": info["tool"], "config": str(config_path.name)}

            if info["tool"] in formatters_set:
                formatters.append(entry)
            else:
                linters.append(entry)

    return linters, formatters


def detect_test_frameworks(test_configs: list[Path]) -> list[dict[str, str]]:
    """Detect test frameworks from config files."""
    frameworks: list[dict[str, str]] = []

    for config_path in test_configs:
        filename = config_path.name
        for pattern, info in TEST_PATTERNS.items():
            if filename == pattern or filename.endswith(pattern):
                frameworks.append({"framework": info["framework"], "config": str(config_path.name)})
                break

    return frameworks


def detect_package_managers(lockfiles: list[Path], project_path: Path) -> list[dict[str, str]]:
    """Detect package managers from lockfiles."""
    managers: list[dict[str, str]] = []
    for path in lockfiles:
        manager = LOCKFILES.get(path.name)
        if not manager:
            continue
        managers.append(
            {
                "manager": manager,
                "evidence": path.relative_to(project_path).as_posix(),
            }
        )
    return sorted(managers, key=lambda item: (item["manager"].lower(), item["evidence"]))


def parse_package_scripts(package_json_files: list[Path], project_path: Path) -> list[dict[str, str]]:
    """Collect package.json scripts without trying to validate commands."""
    commands: list[dict[str, str]] = []

    for path in package_json_files:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue

        scripts = data.get("scripts")
        if not isinstance(scripts, dict):
            continue

        for script_name, command in sorted(scripts.items()):
            if not isinstance(script_name, str) or not isinstance(command, str):
                continue
            commands.append(
                {
                    "path": path.relative_to(project_path).as_posix(),
                    "script": script_name,
                    "command": command,
                }
            )

    return sorted(commands, key=lambda item: (item["path"], item["script"]))


def parse_pyproject_details(
    pyproject_files: list[Path],
    project_path: Path,
) -> tuple[list[dict[str, str]], list[dict[str, str]], set[str]]:
    """Parse enough pyproject.toml metadata to identify pytest and Python version hints."""
    test_frameworks: list[dict[str, str]] = []
    python_version_hints: list[dict[str, str]] = []
    tools: set[str] = set()

    for path in pyproject_files:
        try:
            data = tomllib.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue

        relative_path = path.relative_to(project_path).as_posix()
        project = data.get("project")
        if isinstance(project, dict):
            requires_python = project.get("requires-python")
            if isinstance(requires_python, str):
                python_version_hints.append(
                    {
                        "path": relative_path,
                        "source": "project.requires-python",
                        "value": requires_python,
                    }
                )

        tool = data.get("tool")
        if isinstance(tool, dict):
            pytest_config = tool.get("pytest")
            if isinstance(pytest_config, dict) and "ini_options" in pytest_config:
                tools.add("pytest")
                test_frameworks.append({"framework": "pytest", "config": relative_path})

            poetry = tool.get("poetry")
            if isinstance(poetry, dict):
                dependencies = poetry.get("dependencies")
                if isinstance(dependencies, dict) and isinstance(dependencies.get("python"), str):
                    python_version_hints.append(
                        {
                            "path": relative_path,
                            "source": "tool.poetry.dependencies.python",
                            "value": dependencies["python"],
                        }
                    )

    return (
        sorted(test_frameworks, key=lambda item: item["config"]),
        sorted(python_version_hints, key=lambda item: (item["path"], item["source"])),
        tools,
    )


def analyze_naming_conventions(
    project_path: Path,
    *,
    max_depth: int | None = None,
    max_files: int = DEFAULT_MAX_FILES,
    include_patterns: list[str] | None = None,
    exclude_patterns: list[str] | None = None,
    follow_symlinks: bool = False,
) -> dict[str, str]:
    """Analyze naming conventions from source files."""
    conventions: dict[str, str] = {}

    # Find Python files
    python_files = iter_project_files(
        project_path,
        suffixes={".py"},
        max_files=min(MAX_NAMING_FILES, max_files),
        max_depth=max_depth,
        include_patterns=include_patterns,
        exclude_patterns=exclude_patterns,
        follow_symlinks=follow_symlinks,
    )
    if python_files:
        function_names: list[str] = []
        class_names: list[str] = []
        variable_names: list[str] = []

        func_pattern = re.compile(r"^\s*def\s+(\w+)\s*\(", re.MULTILINE)
        class_pattern = re.compile(r"^\s*class\s+(\w+)", re.MULTILINE)
        var_pattern = re.compile(r"^\s*(\w+)\s*=", re.MULTILINE)

        for py_file in python_files:
            try:
                content = py_file.read_text(errors="ignore")
                function_names.extend(func_pattern.findall(content))
                class_names.extend(class_pattern.findall(content))
                var_matches = var_pattern.findall(content)
                variable_names.extend(v for v in var_matches if not v.startswith("_") and v.isupper())
            except Exception:
                pass

        # Analyze function naming
        if function_names:
            snake_case = sum(1 for n in function_names if "_" in n and n.islower())
            camel_case = sum(1 for n in function_names if n[0].islower() and any(c.isupper() for c in n))
            if snake_case > camel_case:
                conventions["python_functions"] = "snake_case"
            elif camel_case > snake_case:
                conventions["python_functions"] = "camelCase"

        # Analyze class naming
        if class_names:
            pascal_case = sum(1 for n in class_names if n[0].isupper())
            if pascal_case == len(class_names):
                conventions["python_classes"] = "PascalCase"

    # Find TypeScript/JavaScript files
    ts_files = iter_project_files(
        project_path,
        suffixes={".ts", ".tsx"},
        max_files=min(MAX_NAMING_FILES, max_files),
        max_depth=max_depth,
        include_patterns=include_patterns,
        exclude_patterns=exclude_patterns,
        follow_symlinks=follow_symlinks,
    )
    if ts_files:
        func_names: list[str] = []
        ts_func_pattern = re.compile(r"(?:function|const|let)\s+(\w+)\s*[=\(]")

        for ts_file in ts_files:
            try:
                content = ts_file.read_text(errors="ignore")
                func_names.extend(ts_func_pattern.findall(content))
            except Exception:
                pass

        if func_names:
            camel = sum(1 for n in func_names if n[0].islower() and any(c.isupper() for c in n))
            if camel > len(func_names) // 2:
                conventions["typescript_functions"] = "camelCase"

    return conventions


def sample_source_files(
    project_path: Path,
    *,
    max_depth: int | None = None,
    max_files: int = DEFAULT_MAX_FILES,
    include_patterns: list[str] | None = None,
    exclude_patterns: list[str] | None = None,
    follow_symlinks: bool = False,
) -> tuple[int, list[str]]:
    """Sample source files and detect patterns."""
    patterns: list[str] = []
    source_files = iter_project_files(
        project_path,
        suffixes=SOURCE_SUFFIXES,
        max_files=max_files,
        max_depth=max_depth,
        include_patterns=include_patterns,
        exclude_patterns=exclude_patterns,
        follow_symlinks=follow_symlinks,
    )
    count = len(source_files)

    # Check for common patterns in Python
    py_files = [path for path in source_files if path.suffix == ".py"][: min(MAX_PATTERN_FILES, max_files)]

    type_hints = 0
    docstrings = 0
    logging_usage = 0
    print_usage = 0
    pathlib_usage = 0

    for py_file in py_files:
        try:
            content = py_file.read_text(errors="ignore")
            if re.search(r"def\s+\w+\([^)]*:\s*\w+", content):
                type_hints += 1
            if '"""' in content or "'''" in content:
                docstrings += 1
            if "import logging" in content or "logger" in content.lower():
                logging_usage += 1
            if "print(" in content:
                print_usage += 1
            if "from pathlib" in content:
                pathlib_usage += 1
        except Exception:
            pass

    if py_files:
        if type_hints > len(py_files) // 2:
            patterns.append("Type hints used consistently")
        if docstrings > len(py_files) // 2:
            patterns.append("Docstrings present in most files")
        if logging_usage > print_usage:
            patterns.append("Logging preferred over print statements")
        elif print_usage > logging_usage:
            patterns.append("Print statements used (consider logging)")

    if pathlib_usage > len(py_files) // 3:
        patterns.append("pathlib.Path used for file operations")

    return count, patterns


def generate_suggestions(analysis: ProjectAnalysis) -> list[str]:
    """Compatibility field for schema 1.0 callers.

    Schema 1.1 reports missing or ambiguous evidence as uncertainty_items instead
    of content recommendations.
    """
    return []


def generate_uncertainty_items(analysis: ProjectAnalysis) -> list[dict[str, Any]]:
    """Return facts the analyzer could not prove from sampled files."""
    items: list[dict[str, Any]] = []

    if not analysis.languages:
        items.append({"kind": "missing-evidence", "message": "Primary language was not detected from sampled configs"})
    if not analysis.frameworks:
        items.append({"kind": "missing-evidence", "message": "Primary framework or execution model was not detected"})
    if not analysis.package_managers:
        items.append({"kind": "missing-evidence", "message": "Package manager lockfile was not detected"})
    if not analysis.command_inventory:
        items.append({"kind": "missing-evidence", "message": "Package script inventory is empty"})
    if not analysis.linters:
        items.append({"kind": "missing-evidence", "message": "Linter config was not detected"})
    if not analysis.formatters:
        items.append({"kind": "missing-evidence", "message": "Formatter config was not detected"})
    if not analysis.test_frameworks:
        items.append({"kind": "missing-evidence", "message": "Test framework config was not detected"})

    package_managers = sorted({item["manager"] for item in analysis.package_managers})
    if len(package_managers) > 1:
        items.append(
            {
                "kind": "ambiguous-evidence",
                "message": "Multiple package-manager lockfile types were detected",
                "evidence": package_managers,
            }
        )

    return items


def build_detected_facts(analysis: ProjectAnalysis) -> list[dict[str, Any]]:
    """Return coarse provenance for analyzer facts so callers do not treat them as authority."""
    facts: list[dict[str, Any]] = []

    for language in analysis.languages:
        facts.append(
            {
                "kind": "language",
                "name": language,
                "evidence": analysis.config_files,
                "confidence": "high" if analysis.config_files else "low",
            }
        )
    for framework in analysis.frameworks:
        facts.append(
            {
                "kind": "framework",
                "name": framework,
                "evidence": analysis.config_files,
                "confidence": "medium",
            }
        )
    for tool in analysis.tools:
        facts.append(
            {
                "kind": "tool",
                "name": tool,
                "evidence": analysis.config_files,
                "confidence": "medium",
            }
        )
    for package_manager in analysis.package_managers:
        facts.append(
            {
                "kind": "package_manager",
                "name": package_manager["manager"],
                "evidence": [package_manager["evidence"]],
                "confidence": "high",
            }
        )

    return facts


# =============================================================================
# Output Formatting
# =============================================================================


def format_markdown(analysis: ProjectAnalysis) -> str:
    """Format analysis as Markdown."""
    lines: list[str] = []
    lines.append("# Project Analysis Report")
    lines.append("")
    lines.append(f"**Project**: `{analysis.project_path}`")
    lines.append(f"**Schema**: `{analysis.schema_version}`")
    lines.append("")

    if analysis.agents_files:
        lines.append("## AGENTS.md Files Found")
        lines.append("")
        for path in analysis.agents_files:
            lines.append(f"- `{path}`")
        lines.append("")

    # Languages
    lines.append("## Detected Stack")
    lines.append("")
    if analysis.languages:
        lines.append(f"**Languages**: {', '.join(sorted(analysis.languages))}")
    if analysis.frameworks:
        lines.append(f"**Frameworks**: {', '.join(sorted(analysis.frameworks))}")
    if analysis.tools:
        lines.append(f"**Tools**: {', '.join(sorted(analysis.tools))}")
    lines.append("")

    if analysis.package_managers:
        lines.append("## Package Managers")
        lines.append("")
        for package_manager in analysis.package_managers:
            lines.append(f"- {package_manager['manager']} (`{package_manager['evidence']}`)")
        lines.append("")

    # Config files
    if analysis.config_files:
        lines.append("## Configuration Files Found")
        lines.append("")
        for cf in analysis.config_files:
            lines.append(f"- `{cf}`")
        lines.append("")

    if analysis.generated_candidates:
        lines.append("## Generated Or Boundary Candidates")
        lines.append("")
        for path in analysis.generated_candidates:
            lines.append(f"- `{path}`")
        lines.append("")

    if analysis.command_inventory:
        lines.append("## Command Inventory")
        lines.append("")
        for command in analysis.command_inventory:
            lines.append(f"- `{command['path']}` script `{command['script']}`: `{command['command']}`")
        lines.append("")

    if analysis.python_version_hints:
        lines.append("## Python Version Hints")
        lines.append("")
        for hint in analysis.python_version_hints:
            lines.append(f"- `{hint['path']}` {hint['source']}: `{hint['value']}`")
        lines.append("")

    # Linters and formatters
    if analysis.linters or analysis.formatters:
        lines.append("## Code Quality Tools")
        lines.append("")
        if analysis.linters:
            lines.append("**Linters**:")
            for linter in analysis.linters:
                lines.append(f"- {linter['tool']} (`{linter['config']}`)")
        if analysis.formatters:
            lines.append("**Formatters**:")
            for fmt in analysis.formatters:
                lines.append(f"- {fmt['tool']} (`{fmt['config']}`)")
        lines.append("")

    # Testing
    if analysis.test_frameworks:
        lines.append("## Testing")
        lines.append("")
        for tf in analysis.test_frameworks:
            lines.append(f"- {tf['framework']} (`{tf['config']}`)")
        lines.append("")

    # Naming conventions
    if analysis.naming_conventions:
        lines.append("## Naming Conventions Detected")
        lines.append("")
        for element, convention in analysis.naming_conventions.items():
            lines.append(f"- **{element}**: {convention}")
        lines.append("")

    # Patterns
    if analysis.detected_patterns:
        lines.append("## Code Patterns Detected")
        lines.append("")
        for pattern in analysis.detected_patterns:
            lines.append(f"- {pattern}")
        lines.append("")

    if analysis.detected_facts:
        lines.append("## Detected Facts")
        lines.append("")
        for fact in analysis.detected_facts:
            evidence = ", ".join(str(value) for value in fact.get("evidence", []))
            lines.append(
                f"- **{fact.get('kind', 'fact')}** {fact.get('name', 'unknown')} "
                f"({fact.get('confidence', 'unknown')} confidence): `{evidence}`"
            )
        lines.append("")

    # Uncertainty
    if analysis.uncertainty_items:
        lines.append("## Uncertainty Items")
        lines.append("")
        for item in analysis.uncertainty_items:
            suffix = ""
            if item.get("evidence"):
                suffix = f" Evidence: `{', '.join(str(value) for value in item['evidence'])}`"
            lines.append(f"- **{item['kind']}**: {item['message']}{suffix}")
        lines.append("")

    return "\n".join(lines)


def format_json(analysis: ProjectAnalysis) -> str:
    """Format analysis as JSON."""
    return json.dumps(asdict(analysis), indent=2)


# =============================================================================
# Main
# =============================================================================


def analyze_project(
    project_path: Path,
    *,
    max_depth: int | None = None,
    max_files: int = DEFAULT_MAX_FILES,
    include_patterns: list[str] | None = None,
    exclude_patterns: list[str] | None = None,
    follow_symlinks: bool = False,
) -> ProjectAnalysis:
    """Analyze a project directory."""
    analysis = ProjectAnalysis(project_path=str(project_path.resolve()))
    analysis.agents_files = find_agents_files(project_path)
    analysis.generated_candidates = find_generated_candidates(project_path, max_depth=max_depth)

    # Find config files
    config_files = find_config_files(project_path, max_files=max_files)

    # Store found config files
    all_configs = (
        config_files["language_configs"]
        + config_files["linter_configs"]
        + config_files["test_configs"]
        + config_files["lockfiles"]
    )
    analysis.config_files = [p.relative_to(project_path).as_posix() for p in dedupe_paths(all_configs)]

    # Detect languages and frameworks
    languages, frameworks, tools = detect_languages_and_frameworks(config_files["language_configs"])
    analysis.package_managers = detect_package_managers(config_files["lockfiles"], project_path)
    tools.update(package_manager["manager"] for package_manager in analysis.package_managers)

    pyproject_files = [path for path in config_files["language_configs"] if path.name == "pyproject.toml"]
    pyproject_tests, python_version_hints, pyproject_tools = parse_pyproject_details(pyproject_files, project_path)
    tools.update(pyproject_tools)

    analysis.languages = sorted(languages)
    analysis.frameworks = sorted(frameworks)
    analysis.tools = sorted(tools)
    analysis.python_version_hints = python_version_hints

    package_json_files = [path for path in config_files["language_configs"] if path.name == "package.json"]
    analysis.command_inventory = parse_package_scripts(package_json_files, project_path)

    # Detect linters and formatters
    linters, formatters = detect_linters_and_formatters(config_files["linter_configs"])
    analysis.linters = linters
    analysis.formatters = formatters

    # Detect test frameworks
    test_frameworks = detect_test_frameworks(config_files["test_configs"]) + pyproject_tests
    analysis.test_frameworks = sorted(
        {json.dumps(item, sort_keys=True): item for item in test_frameworks}.values(),
        key=lambda item: (item["framework"], item["config"]),
    )

    # Analyze naming conventions
    analysis.naming_conventions = analyze_naming_conventions(
        project_path,
        max_depth=max_depth,
        max_files=max_files,
        include_patterns=include_patterns,
        exclude_patterns=exclude_patterns,
        follow_symlinks=follow_symlinks,
    )

    # Sample source files
    count, patterns = sample_source_files(
        project_path,
        max_depth=max_depth,
        max_files=max_files,
        include_patterns=include_patterns,
        exclude_patterns=exclude_patterns,
        follow_symlinks=follow_symlinks,
    )
    analysis.source_files_sampled = count
    analysis.detected_patterns = patterns
    analysis.detected_facts = build_detected_facts(analysis)

    # Keep suggestions for schema 1.0 compatibility and report evidence gaps separately.
    analysis.suggestions = generate_suggestions(analysis)
    analysis.uncertainty_items = generate_uncertainty_items(analysis)

    return analysis


def main() -> int:
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Analyze a project to bootstrap AGENTS.md creation.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    python analyze_project.py .
    python analyze_project.py /path/to/project --output json
    python analyze_project.py ~/code/my-app --output markdown
        """,
    )
    parser.add_argument(
        "project_path",
        nargs="?",
        type=Path,
        help="Path to the project directory to analyze",
    )
    parser.add_argument("--repo-root", type=Path, help="Path to the project directory to analyze")
    parser.add_argument(
        "--output",
        "--format",
        "-o",
        dest="output",
        choices=["markdown", "json"],
        default="markdown",
        help="Output format (default: markdown)",
    )
    parser.add_argument(
        "--max-depth",
        type=int,
        help="Maximum directory depth to recursively sample for source and test files",
    )
    parser.add_argument(
        "--max-files",
        type=int,
        default=DEFAULT_MAX_FILES,
        help="Maximum number of source files to sample per detector",
    )
    parser.add_argument("--include", action="append", default=[], help="Glob pattern to include in source sampling")
    parser.add_argument("--exclude", action="append", default=[], help="Glob pattern to exclude from source sampling")
    parser.add_argument("--follow-symlinks", action="store_true", help="Follow symlinked directories during sampling")

    args = parser.parse_args()

    if args.project_path is not None and args.repo_root is not None:
        parser.error("Provide the project path as either positional project_path or --repo-root, not both")
    project_arg = args.repo_root if args.repo_root is not None else args.project_path
    if project_arg is None:
        parser.error("Provide a project path with --repo-root or positional project_path")
    if args.max_depth is not None and args.max_depth < 0:
        parser.error("--max-depth must be >= 0")
    if args.max_files < 1:
        parser.error("--max-files must be >= 1")

    project_path = project_arg.resolve()
    if not project_path.exists():
        print(f"Error: Project path does not exist: {project_path}", file=sys.stderr)
        return 2

    if not project_path.is_dir():
        print(f"Error: Project path is not a directory: {project_path}", file=sys.stderr)
        return 2

    analysis = analyze_project(
        project_path,
        max_depth=args.max_depth,
        max_files=args.max_files,
        include_patterns=args.include,
        exclude_patterns=args.exclude,
        follow_symlinks=args.follow_symlinks,
    )

    if args.output == "json":
        print(format_json(analysis))
    else:
        print(format_markdown(analysis))

    return 0


if __name__ == "__main__":
    sys.exit(main())
