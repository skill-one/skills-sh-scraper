"""Inventory project documentation and recommend missing core docs."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import TypedDict
from urllib.parse import unquote


class DocumentStatus(TypedDict):
    path: str
    present: bool
    purpose: str


class MarkdownLinkStatus(TypedDict):
    document: str
    target: str
    status: str
    resolved_path: str


class NotebookStatus(TypedDict):
    path: str
    code_cells: int
    markdown_cells: int
    parse_error: str


class AuditReport(TypedDict):
    project_root: str
    existing_markdown: list[str]
    readme_casing: list[str]
    markdown_links: list[MarkdownLinkStatus]
    broken_markdown_links: list[MarkdownLinkStatus]
    notebook_summaries: list[NotebookStatus]
    do_not_edit_mentions: list[str]
    meta_label_mentions: list[str]
    core_documents: list[DocumentStatus]
    optional_documents: list[DocumentStatus]
    missing_core_documents: list[str]
    recommended_guides: list[str]
    diagram_policy: str


CORE_DOCS = {
    "README.md": "Project entry point and setup.",
    "CHANGELOG.md": "Release history.",
    "docs/architecture.md": "System structure and major components.",
}

OPTIONAL_DOCS = {
    "docs/dataflow-diagram.md": "Optional. Only if the project already maintains diagram docs or the user explicitly asked.",
    "docs/functional-diagram.md": "Optional. Prefer prose or tables unless a diagram is explicitly useful.",
}

MARKDOWN_LINK_RE = re.compile(r"(?<!!)\[[^\]]+\]\(([^)]+)\)")
META_LABEL_RE = re.compile(
    r"\b(review packet|AI commentary|AI-generated summary|generated summary|analysis artifact)\b", re.IGNORECASE
)
DO_NOT_EDIT_RE = re.compile(r"\b(do not edit|do-not-edit)\b", re.IGNORECASE)

EXCLUDED_DIR_NAMES = {
    ".git",
    ".hg",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".tox",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "venv",
}


def is_excluded(path: Path, root: Path) -> bool:
    """Return whether a path is nested under a dependency or cache directory."""
    relative_parts = path.relative_to(root).parts[:-1]
    return any(part in EXCLUDED_DIR_NAMES for part in relative_parts)


def collect_markdown_files(root: Path) -> list[str]:
    """Return markdown files under root, excluding vendor and cache directories."""
    return sorted(
        str(path.relative_to(root)).replace("\\", "/")
        for path in root.rglob("*.md")
        if path.is_file() and not is_excluded(path, root)
    )


def collect_notebook_files(root: Path) -> list[Path]:
    """Return notebook files under root, excluding vendor and cache directories."""
    return sorted(path for path in root.rglob("*.ipynb") if path.is_file() and not is_excluded(path, root))


def find_readme_casing(root: Path) -> list[str]:
    """Return README-like files whose casing is not canonical."""
    return sorted(
        str(path.relative_to(root)).replace("\\", "/")
        for path in root.rglob("*")
        if path.is_file()
        and not is_excluded(path, root)
        and path.name.lower() == "readme.md"
        and path.name != "README.md"
    )


def _strip_markdown_link_target(target: str) -> str:
    """Return link target without title, anchor, or URL escaping."""
    target = target.strip()
    if not target or target.startswith("#"):
        return ""
    if re.match(r"^[a-z][a-z0-9+.-]*:", target, re.IGNORECASE):
        return ""
    if " " in target and not target.startswith("<"):
        target = target.split(" ", maxsplit=1)[0]
    target = target.strip("<>")
    target = target.split("#", maxsplit=1)[0]
    return unquote(target)


def _is_within_root(path: Path, root: Path) -> bool:
    """Return whether path is within root."""
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def _exact_case_exists(path: Path, root: Path) -> bool:
    """Return whether a path exists with exact casing relative to root."""
    try:
        relative = path.resolve().relative_to(root.resolve())
    except ValueError:
        return False

    current = root.resolve()
    for part in relative.parts:
        try:
            matching = [child.name for child in current.iterdir() if child.name == part]
        except OSError:
            return False
        if not matching:
            return False
        current = current / part
    return True


def audit_markdown_links(root: Path, markdown_files: list[str]) -> list[MarkdownLinkStatus]:
    """Return local markdown link status records."""
    results: list[MarkdownLinkStatus] = []
    for relative_doc in markdown_files:
        doc_path = root / relative_doc
        text = doc_path.read_text(encoding="utf-8", errors="replace")
        for match in MARKDOWN_LINK_RE.finditer(text):
            raw_target = match.group(1)
            target = _strip_markdown_link_target(raw_target)
            if not target:
                continue
            resolved = (doc_path.parent / target).resolve()
            if not _is_within_root(resolved, root):
                status = "outside_root"
            elif not resolved.exists():
                status = "missing"
            elif not _exact_case_exists(resolved, root):
                status = "case_mismatch"
            else:
                status = "ok"
            results.append(
                {
                    "document": relative_doc,
                    "target": raw_target,
                    "status": status,
                    "resolved_path": str(resolved),
                }
            )
    return results


def summarize_notebook(path: Path, root: Path) -> NotebookStatus:
    """Return code/markdown cell counts for a notebook."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return {
            "path": str(path.relative_to(root)).replace("\\", "/"),
            "code_cells": 0,
            "markdown_cells": 0,
            "parse_error": str(exc),
        }

    code_cells = 0
    markdown_cells = 0
    for cell in data.get("cells", []):
        if cell.get("cell_type") == "code":
            code_cells += 1
        elif cell.get("cell_type") == "markdown":
            markdown_cells += 1
    return {
        "path": str(path.relative_to(root)).replace("\\", "/"),
        "code_cells": code_cells,
        "markdown_cells": markdown_cells,
        "parse_error": "",
    }


def collect_regex_mentions(root: Path, markdown_files: list[str], pattern: re.Pattern[str]) -> list[str]:
    """Return markdown files containing a pattern."""
    matches = []
    for relative_doc in markdown_files:
        text = (root / relative_doc).read_text(encoding="utf-8", errors="replace")
        if pattern.search(text):
            matches.append(relative_doc)
    return matches


def build_report(root: Path) -> AuditReport:
    """Build a documentation inventory for the project root."""
    existing = collect_markdown_files(root)
    existing_set = set(existing)
    markdown_links = audit_markdown_links(root, existing)

    core: list[DocumentStatus] = []
    for path, purpose in CORE_DOCS.items():
        core.append(
            {
                "path": path,
                "present": path in existing_set,
                "purpose": purpose,
            }
        )

    optional: list[DocumentStatus] = []
    for path, purpose in OPTIONAL_DOCS.items():
        optional.append(
            {
                "path": path,
                "present": path in existing_set,
                "purpose": purpose,
            }
        )

    missing_core = [item["path"] for item in core if not item["present"]]
    recommended_guides = []
    if "README.md" in missing_core:
        recommended_guides.append("references/guide-readme.md")
    if "docs/architecture.md" in missing_core:
        recommended_guides.append("references/guide-architecture.md")
    if "CHANGELOG.md" in missing_core:
        recommended_guides.append("references/guide-changelog.md")

    return {
        "project_root": str(root),
        "existing_markdown": existing,
        "readme_casing": find_readme_casing(root),
        "markdown_links": markdown_links,
        "broken_markdown_links": [item for item in markdown_links if item["status"] != "ok"],
        "notebook_summaries": [summarize_notebook(path, root) for path in collect_notebook_files(root)],
        "do_not_edit_mentions": collect_regex_mentions(root, existing, DO_NOT_EDIT_RE),
        "meta_label_mentions": collect_regex_mentions(root, existing, META_LABEL_RE),
        "core_documents": core,
        "optional_documents": optional,
        "missing_core_documents": missing_core,
        "recommended_guides": recommended_guides,
        "diagram_policy": "Treat diagram documents as opt-in. Do not generate them by default.",
    }


def print_markdown_report(report: AuditReport) -> None:
    """Print a human-readable markdown report."""
    print("# Documentation Audit\n")
    print(f"Project root: {report['project_root']}\n")

    print("## Core Documents")
    for item in report["core_documents"]:
        status = "present" if item["present"] else "missing"
        print(f"- {item['path']}: {status} - {item['purpose']}")

    print("\n## Optional Documents")
    for item in report["optional_documents"]:
        status = "present" if item["present"] else "not present"
        print(f"- {item['path']}: {status} - {item['purpose']}")

    print("\n## Recommended Guides")
    guides = report["recommended_guides"]
    if guides:
        for guide in guides:
            print(f"- {guide}")
    else:
        print("- none")

    print("\n## Policy")
    print(f"- {report['diagram_policy']}")

    print("\n## Drift Checks")
    if report["broken_markdown_links"]:
        print("- broken or suspicious markdown links:")
        for item in report["broken_markdown_links"]:
            print(f"  - {item['document']} -> {item['target']} ({item['status']})")
    else:
        print("- markdown links: ok")

    if report["readme_casing"]:
        print("- noncanonical README casing:")
        for path in report["readme_casing"]:
            print(f"  - {path}")
    else:
        print("- README casing: ok")

    if report["do_not_edit_mentions"]:
        print("- do-not-edit sidecar mentions:")
        for path in report["do_not_edit_mentions"]:
            print(f"  - {path}")

    if report["meta_label_mentions"]:
        print("- generated/meta label mentions:")
        for path in report["meta_label_mentions"]:
            print(f"  - {path}")

    if report["notebook_summaries"]:
        print("\n## Notebook Summaries")
        for item in report["notebook_summaries"]:
            status = f"parse_error={item['parse_error']}" if item["parse_error"] else "ok"
            print(
                f"- {item['path']}: code_cells={item['code_cells']}, markdown_cells={item['markdown_cells']} ({status})"
            )


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit existing project documentation")
    parser.add_argument("project_root", help="Path to the project root")
    parser.add_argument("--json", action="store_true", help="Emit JSON instead of markdown")
    args = parser.parse_args()

    root = Path(args.project_root).resolve()
    if not root.exists():
        parser.error(f"Project root does not exist: {root}")
    if not root.is_dir():
        parser.error(f"Project root is not a directory: {root}")

    report = build_report(root)

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print_markdown_report(report)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
