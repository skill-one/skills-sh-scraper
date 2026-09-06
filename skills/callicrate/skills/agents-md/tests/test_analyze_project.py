from __future__ import annotations

from pathlib import Path

import analyze_project


def test_analyzer_detects_root_python_config(tmp_path: Path) -> None:
    (tmp_path / "pyproject.toml").write_text(
        """[project]
name = "example"
requires-python = ">=3.11"

[tool.pytest.ini_options]
testpaths = ["tests"]
""",
        encoding="utf-8",
    )

    analysis = analyze_project.analyze_project(tmp_path)

    assert analysis.schema_version == "1.1"
    assert "Python" in analysis.languages
    assert "pyproject.toml" in analysis.config_files
    assert "pytest" in analysis.tools
    assert {"framework": "pytest", "config": "pyproject.toml"} in analysis.test_frameworks
    assert {
        "path": "pyproject.toml",
        "source": "project.requires-python",
        "value": ">=3.11",
    } in analysis.python_version_hints


def test_analyzer_markdown_omits_empty_configuration_files_section(tmp_path: Path) -> None:
    (tmp_path / "pyproject.toml").write_text("[project]\nname = 'example'\n", encoding="utf-8")

    markdown = analyze_project.format_markdown(analyze_project.analyze_project(tmp_path))

    assert "## Configuration Files Found\n\n##" not in markdown
    assert "## Configuration Files Found\n\n- `pyproject.toml`" in markdown
    assert "## Next Steps" not in markdown


def test_analyzer_detects_nested_package_json(tmp_path: Path) -> None:
    package_dir = tmp_path / "packages" / "web"
    package_dir.mkdir(parents=True)
    (package_dir / "package.json").write_text(
        """{
  "scripts": {
    "test": "vitest run",
    "build": "tsc -b"
  },
  "dependencies": {
    "react": "^19.0.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0"
  }
}
""",
        encoding="utf-8",
    )

    analysis = analyze_project.analyze_project(tmp_path)

    assert "packages/web/package.json" in analysis.config_files
    assert "React" in analysis.frameworks
    assert "TypeScript" in analysis.languages
    assert {
        "path": "packages/web/package.json",
        "script": "test",
        "command": "vitest run",
    } in analysis.command_inventory


def test_analyzer_detects_common_nested_package_json_layouts(tmp_path: Path) -> None:
    for prefix in ("apps", "services"):
        package_dir = tmp_path / prefix / "api"
        package_dir.mkdir(parents=True)
        (package_dir / "package.json").write_text(
            """{
  "scripts": {
    "lint": "eslint ."
  },
  "dependencies": {
    "express": "^5.0.0"
  }
}
""",
            encoding="utf-8",
        )

    analysis = analyze_project.analyze_project(tmp_path)

    assert "apps/api/package.json" in analysis.config_files
    assert "services/api/package.json" in analysis.config_files
    assert {
        "path": "apps/api/package.json",
        "script": "lint",
        "command": "eslint .",
    } in analysis.command_inventory
    assert "Express" in analysis.frameworks


def test_analyzer_detects_package_managers_from_lockfiles(tmp_path: Path) -> None:
    for lockfile in ("package-lock.json", "pnpm-lock.yaml", "uv.lock", "Cargo.lock"):
        (tmp_path / lockfile).write_text("", encoding="utf-8")

    analysis = analyze_project.analyze_project(tmp_path)

    assert {"manager": "npm", "evidence": "package-lock.json"} in analysis.package_managers
    assert {"manager": "pnpm", "evidence": "pnpm-lock.yaml"} in analysis.package_managers
    assert {"manager": "uv", "evidence": "uv.lock"} in analysis.package_managers
    assert {"manager": "Cargo", "evidence": "Cargo.lock"} in analysis.package_managers
    assert any(item["kind"] == "ambiguous-evidence" for item in analysis.uncertainty_items)


def test_analyzer_markdown_renders_json_fact_sections(tmp_path: Path) -> None:
    (tmp_path / "package-lock.json").write_text("{}", encoding="utf-8")
    (tmp_path / "package.json").write_text(
        """{
  "scripts": {
    "test": "npm run unit"
  }
}
""",
        encoding="utf-8",
    )

    analysis = analyze_project.analyze_project(tmp_path)
    markdown = analyze_project.format_markdown(analysis)

    assert "## Package Managers\n\n- npm (`package-lock.json`)" in markdown
    assert "## Command Inventory\n\n- `package.json` script `test`: `npm run unit`" in markdown
    assert "## Suggestions for AGENTS.md" not in markdown
