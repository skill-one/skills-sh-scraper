# Tool Contracts

Use this reference before invoking or changing the deterministic helpers bundled with this skill.
All paths should be passed explicitly so commands work from any current directory.

## General Rules

- `<skill-root>` is the directory that contains this `SKILL.md`.
- `<target-repo>` is the repository or subdirectory whose `AGENTS.md` is being created, reviewed, or updated.
- `<target-agents-file>` is the exact `AGENTS.md` being checked, root or nested.
- Deterministic helpers inspect files and parse documented commands. They must not execute project build, deploy, migration, credential, production, or live-target commands.
- Resolve symlinks before containment checks. Paths that escape the target repo fail unless explicitly labeled external and not used as local edit targets.
- Exit 0 means the requested check passed.
- Exit 1 means validation found structural or semantic failures.
- Exit 2 means usage, path, or configuration failure.
- `--json` emits `{ "status": "pass|fail", "findings": [...] }` with stable `severity`, `code`, `path`, `line`, and `message` fields.

## analyze_project.py

Use for standard and exhaustive work.
The analyzer is a sampling guide, not authority.

```bash
python <skill-root>/scripts/analyze_project.py --repo-root <target-repo> --format json
python <skill-root>/scripts/analyze_project.py --repo-root <target-repo> --format markdown --max-depth 4 --max-files 200
```

Required input: `--repo-root <target-repo>` or positional `<target-repo>`.

Options:

- `--format {json,markdown}` or `--output {json,markdown}` controls output format.
- `--max-depth <n>` limits recursive sampling depth for large repos.
- `--max-files <n>` limits recursive source sampling.
- `--include <glob>` adds file-selection globs for source sampling.
- `--exclude <glob>` excludes file-selection globs from source sampling.
- `--follow-symlinks` opts into following symlinked directories. Default is false.

Output:

- Current JSON schema is `1.1`.
- JSON includes `schema_version`, `project_path`, `agents_files`, `languages`, `frameworks`, `tools`, `package_managers`, `command_inventory`, `python_version_hints`, `linters`, `formatters`, `test_frameworks`, `naming_conventions`, `config_files`, `generated_candidates`, `source_files_sampled`, `detected_patterns`, `detected_facts`, `suggestions`, and `uncertainty_items`.
- The `suggestions` field is retained for schema `1.0` compatibility and is empty in schema `1.1`; evidence gaps are reported as `uncertainty_items`.
- Markdown is a human-readable version of the same inventory.

The analyzer skips generated, dependency, cache, VCS, virtualenv, build-output, vendored, and large artifact directories.

## validate_agentsmd.py

Use after drafting or reviewing a target `AGENTS.md`.

```bash
python <skill-root>/scripts/validate_agentsmd.py --repo-root <target-repo> --agents-file <target-agents-file> --mode standard
python <skill-root>/scripts/validate_agentsmd.py --repo-root <target-repo> --agents-file <target-agents-file> --mode standard --intent create
python <skill-root>/scripts/validate_agentsmd.py --agents-file <target-agents-file> --mode quick
python <skill-root>/scripts/validate_agentsmd.py <target-agents-file> --mode exhaustive
```

Required input: `--agents-file <target-agents-file>` or positional `<target-agents-file>`.
`--repo-root` is accepted for contract clarity and future checks; structural validation does not require it.

Modes:

- `quick`: Markdown structure, one H1, heading order, fences, smart punctuation, unresolved placeholders, and generic filler.
- `standard`: quick checks plus unsafe command wording checks and checks for any present contract-bearing or related-doc sections.
- `exhaustive`: standard checks with the same deterministic structural rules, intended to pair with semantic and contract-specific manual checks.

Intent:

- `--intent update` is the default and preserves existing structure while still rejecting placeholders, generic filler, broken headings, and unsafe unlabeled commands.
- `--intent create --mode standard` additionally requires H1, Scope, Context, and Project Rules.
- `review`, `split`, and `move` use update-style structural preservation with mode-specific length-budget findings.

Heading policy:

- New files should include H1, Scope, Context, and Project Rules.
- Repository Map, Local Commands, Testing, Tool and Workflow Contracts, Coordination and Evidence, Do / Don't, and Related Docs are conditional.
- Optional sections may be omitted, but known sections should preserve the canonical order from [template-selection.md](template-selection.md).

Standard validation flags generic filler such as "write clean code," "follow best practices," "add tests when appropriate," "handle errors properly," and "use meaningful names" unless tied to concrete repo evidence.
It also flags normal-path commands containing deploy, destroy, reset, drop, migrate, replay, prod, production, credential, token, secret, live, or target unless marked inspected-only, maintainer-only, dry-run, or explicitly safe local fixture.
Related Docs entries must include both a relative path and a trigger or reason, not just a bare link.

Optional `--evidence <file>` validates a repo-owned evidence file only when the user or repository contract asks for one.
Do not create an evidence file solely to satisfy this option.

## semantic_check_agentsmd.py

Use when `AGENTS.md` cites paths, links, commands, configs, tools, or examples.

```bash
python <skill-root>/scripts/semantic_check_agentsmd.py --repo-root <target-repo> --agents-file <target-agents-file>
python <skill-root>/scripts/semantic_check_agentsmd.py --repo-root <target-repo> --agents-file <target-agents-file> --strict-command-tools
```

Required input: `--agents-file <target-agents-file>` or positional `<target-agents-file>`.
`--repo-root` defaults to the `AGENTS.md` parent when omitted.

Checks:

- Markdown links stay inside the target repo and resolve.
- Inline path-like references stay inside the target repo and resolve.
- Literal paths resolve after symlink normalization.
- Glob patterns are allowed when at least one match exists or the text labels them as a pattern.
- Angle-bracket placeholders such as `status/<run-id>.md` are treated as task-specific path patterns.
- Paths labeled planned, external, or pattern are not required to exist as local repo paths.
- Environment variables, table names, URLs, and external platform paths are not treated as local repo paths.
- Fenced shell commands reference package scripts, make targets, local executable paths, or repo configs when those can be checked without executing them.
- When multiple package-manager lockfiles exist, commands are valid only if supported by package scripts, existing `AGENTS.md` policy, or authoritative repo docs.
- JSON, TOML, and Python examples parse when they contain no placeholders.
- `--strict-command-tools` additionally requires command binaries to be on PATH when no repo config proves them. It does not execute those commands.
	In normal use, missing optional tools should be reported in the final response unless `AGENTS.md` presents them as required for normal local work.

## check_agentsmd_templates.py

Use when this skill's assets, references, templates, or scripts change.

```bash
python <skill-root>/scripts/check_agentsmd_templates.py <skill-root>
```

Checks:

- Markdown fences are closed.
- Smart punctuation is avoided.
- Starter templates avoid generic filler and overly concrete sample data.
- Required starter templates and core references exist.

## run_agentsmd_fixture_checks.py

Use when validator behavior changes.

```bash
python <skill-root>/scripts/run_agentsmd_fixture_checks.py
```

Checks:

- Known-good minimal fixture passes structural and semantic validation.
- Contract-bearing and operational fixtures pass structural and semantic validation.
- Bad placeholder fixture fails structural validation.
- Bad stale-path fixture fails semantic validation.
- Bad unsafe-command and broken-link fixtures fail.
- Good maintainer-only and dynamic-path fixtures pass.

## Helper Failures

If a helper exits 1, fix the reported `AGENTS.md` findings or report them for review-only work.
If a helper exits 2, correct the command arguments, target paths, or configuration and rerun it.
For analyzer timeouts on large repositories, narrow sampling with `--max-depth`, `--max-files`, `--include`, or `--exclude` and rerun the helper.
