#!/usr/bin/env python3

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path


ALWAYS_RULE_DIRS = ("core", "quality", "workflows")
TOOL_CHOICES = ("opencode", "claude", "gemini", "codex", "all")
SKIP_NAMES = {".DS_Store", "__pycache__"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Project .agent assets into tool-specific layouts.",
    )
    parser.add_argument("--tool", choices=TOOL_CHOICES, required=True)
    parser.add_argument("--target", required=True, help="Target project directory")
    parser.add_argument("--profile", help="Optional profile fragment name")
    parser.add_argument(
        "--allow-self-target",
        action="store_true",
        help="Allow projecting into the source repo itself",
    )
    parser.add_argument(
        "--tech",
        action="append",
        default=[],
        help="Optional tech fragment name; repeat or pass comma-separated values",
    )
    return parser.parse_args()


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def flatten_tech_values(raw_values: list[str]) -> list[str]:
    result: list[str] = []
    for raw in raw_values:
        for item in raw.split(","):
            value = item.strip()
            if value and value not in result:
                result.append(value)
    return result


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def copy_file(src: Path, dst: Path) -> None:
    if src.resolve() == dst.resolve():
        return
    ensure_dir(dst.parent)
    shutil.copy2(src, dst)


def copy_tree(src: Path, dst: Path) -> None:
    if not src.exists():
        return
    if src.resolve() == dst.resolve():
        return

    for path in src.rglob("*"):
        if any(part in SKIP_NAMES for part in path.parts):
            continue
        relative = path.relative_to(src)
        target = dst / relative
        if path.is_dir():
            ensure_dir(target)
        else:
            copy_file(path, target)


def sorted_markdown_files(directory: Path) -> list[Path]:
    if not directory.exists():
        return []
    return sorted(path for path in directory.rglob("*.md") if path.is_file())


def collect_rule_files(rules_root: Path, profile: str | None, techs: list[str]) -> list[Path]:
    files: list[Path] = []

    for section in ALWAYS_RULE_DIRS:
        files.extend(sorted_markdown_files(rules_root / section))

    if profile:
        profile_file = rules_root / "profiles" / f"{profile}.md"
        if not profile_file.exists():
            raise FileNotFoundError(f"Unknown profile fragment: {profile}")
        files.append(profile_file)

    for tech in techs:
        tech_file = rules_root / "tech" / f"{tech}.md"
        if not tech_file.exists():
            raise FileNotFoundError(f"Unknown tech fragment: {tech}")
        files.append(tech_file)

    if not files:
        raise FileNotFoundError("No rule fragments found under .agent/rules")

    return files


def compose_instructions(rule_files: list[Path]) -> str:
    header = (
        "# Generated file\n\n"
        "Edit `.agent/` first, then regenerate projections with `scripts/project_assets.py`."
    )
    body_parts = [path.read_text(encoding="utf-8").strip() for path in rule_files]
    body = "\n\n".join(part for part in body_parts if part)
    return f"{header}\n\n{body}\n"


def write_text(path: Path, content: str) -> None:
    ensure_dir(path.parent)
    path.write_text(content, encoding="utf-8")


def project_shared_assets(source_root: Path, target_root: Path) -> None:
    copy_tree(source_root / ".agent", target_root / ".agent")
    copy_file(source_root / "scripts" / "project_assets.py", target_root / "scripts" / "project_assets.py")
    copy_file(source_root / "scripts" / "bootstrap-init.sh", target_root / "scripts" / "bootstrap-init.sh")


def project_opencode(source_root: Path, target_root: Path) -> None:
    tool_root = target_root / ".opencode"
    copy_tree(source_root / ".agent" / "commands", tool_root / "commands")
    copy_tree(source_root / ".agent" / "rules", tool_root / "rules")
    copy_tree(source_root / ".agent" / "skills", tool_root / "skills")
    copy_tree(source_root / ".agent" / "plugins" / "opencode", tool_root / "plugins")


def project_mirror_tool(source_root: Path, target_root: Path, tool_dir: str) -> None:
    mirror_root = target_root / tool_dir
    copy_tree(source_root / ".agent" / "commands", mirror_root / "commands")
    copy_tree(source_root / ".agent" / "rules", mirror_root / "rules")
    copy_tree(source_root / ".agent" / "skills", mirror_root / "skills")


def main() -> int:
    args = parse_args()
    source_root = repo_root()
    target_root = Path(args.target).expanduser().resolve()
    techs = flatten_tech_values(args.tech)

    if target_root == source_root and not args.allow_self_target:
        print(
            "error: refusing to project into the bootstrap source repo root; use a test-harness target or pass --allow-self-target",
            file=sys.stderr,
        )
        return 1

    ensure_dir(target_root)
    project_shared_assets(source_root, target_root)

    rule_files = collect_rule_files(source_root / ".agent" / "rules", args.profile, techs)
    instructions = compose_instructions(rule_files)
    write_text(target_root / "AGENTS.md", instructions)

    tools = [args.tool] if args.tool != "all" else ["opencode", "claude", "gemini", "codex"]

    for tool in tools:
        if tool == "opencode":
            project_opencode(source_root, target_root)
        elif tool == "claude":
            project_mirror_tool(source_root, target_root, ".claude")
            write_text(target_root / "CLAUDE.md", instructions)
        elif tool == "gemini":
            project_mirror_tool(source_root, target_root, ".gemini")
            write_text(target_root / "GEMINI.md", instructions)
        elif tool == "codex":
            project_mirror_tool(source_root, target_root, ".codex")

    print(f"Projected .agent assets into {target_root}")
    print("Generated:")
    print(f"- {target_root / 'AGENTS.md'}")
    if "opencode" in tools:
        print(f"- {target_root / '.opencode'}")
    if "claude" in tools:
        print(f"- {target_root / 'CLAUDE.md'}")
        print(f"- {target_root / '.claude'}")
    if "gemini" in tools:
        print(f"- {target_root / 'GEMINI.md'}")
        print(f"- {target_root / '.gemini'}")
    if "codex" in tools:
        print(f"- {target_root / '.codex'}")

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except FileNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1)
