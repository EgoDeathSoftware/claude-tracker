"""Incremental ingestion of transcripts into the derived cache.

Only files whose ``(mtime, size)`` changed are re-parsed, so a warm run over the corpus does
almost no work. A cold run is the expensive one and is expected to be rare.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from sqlite3 import Connection

from sessionkit import sources as src
from sessionkit.classify import annotate_errors, derive_end_state, detect
from sessionkit.parse import parse_file, project_key
from sessionkit import cache


@dataclass
class IngestStats:
    """Outcome of one ingestion pass."""

    parsed: int = 0
    skipped: int = 0
    failed: int = 0
    sources_scanned: int = 0
    sources_unreachable: list[str] = field(default_factory=list)
    prompts: int = 0

    def summary(self) -> str:
        """One-line human summary."""
        missing = f", {len(self.sources_unreachable)} unreachable" if \
            self.sources_unreachable else ""
        return (f"{self.parsed} parsed, {self.skipped} unchanged, {self.failed} failed "
                f"across {self.sources_scanned} source(s){missing}")


def _transcripts(source: src.Source) -> list[tuple[Path, str]]:
    """Every ``.jsonl`` transcript under a source, paired with its project directory name.

    Two layouts exist and both must be walked. Top-level sessions live at
    ``projects/<project>/<session>.jsonl``; **subagent** transcripts live one level deeper at
    ``projects/<project>/<parent-session>/subagents/agent-*.jsonl`` — 36 of this corpus's 86
    files. Globbing only the top level silently drops every subagent, which would leave
    delegation analysis with nothing to measure.
    """
    found: list[tuple[Path, str]] = []
    root = source.projects_dir
    if not root.is_dir():
        return found
    try:
        entries = sorted(p for p in root.iterdir() if p.is_dir())
    except OSError:
        return found
    for project_dir in entries:
        try:
            files = sorted(project_dir.glob("*.jsonl"))
            files.extend(sorted(project_dir.glob("*/subagents/*.jsonl")))
        except OSError:
            continue
        found.extend((f, project_dir.name) for f in files)
    return found


def _record_sources(conn: Connection, found: list[src.Source]) -> None:
    """Refresh the sources table so ``sk doctor`` can report reachability."""
    conn.execute("DELETE FROM sources")
    conn.executemany(
        "INSERT INTO sources VALUES (?,?,?,?,?,?,?,?,?)",
        [(s.id, s.kind, s.layout, s.location, str(s.root), int(s.reachable), s.note,
          s.parent_id or "", s.origin.get("container", "")) for s in found],
    )


def _ingest_one(conn: Connection, source: src.Source, path: Path, dir_name: str,
                stats: IngestStats, full: bool) -> None:
    """Parse and store a single transcript unless the cache is already current."""
    try:
        info = path.stat()
    except OSError:
        stats.failed += 1
        return
    if not full and cache.is_fresh(conn, str(path), info.st_mtime, info.st_size):
        stats.skipped += 1
        return

    session = parse_file(path, source.id)
    if source.location == "container":
        session.cwd = src.rewrite_cwd(session.cwd, source.origin)
    annotate_errors(session)
    session.end_state, session.end_reason = derive_end_state(session)
    anomalies = detect(session)
    cache.store(conn, session, project_key(session.cwd, source.id, dir_name),
                info.st_mtime, info.st_size, anomalies)
    stats.parsed += 1


def _ingest_prompts(conn: Connection, host: src.Source | None) -> int:
    """Load the host source's ``history.jsonl`` so prompts can be joined to sessions."""
    if host is None:
        return 0
    path = host.root / "history.jsonl"
    if not path.is_file():
        return 0
    conn.execute("DELETE FROM prompts")
    rows: list[tuple[str, str, str, str]] = []
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(rec, dict):
                rows.append((str(rec.get("sessionId") or ""), str(rec.get("timestamp") or ""),
                             str(rec.get("project") or ""), str(rec.get("display") or "")))
    conn.executemany("INSERT INTO prompts VALUES (?,?,?,?)", rows)
    return len(rows)


def run(conn: Connection, full: bool = False, only: str | None = None) -> IngestStats:
    """Ingest every reachable source into the cache.

    Args:
        conn: Open cache connection.
        full: Re-parse every transcript even when the cache looks current.
        only: Restrict to a single source id.

    Returns:
        Statistics for the pass, including the sources that could not be read.
    """
    stats = IngestStats()
    found = src.discover()
    _record_sources(conn, found)
    stats.sources_unreachable = [f"{s.id} ({s.note})" for s in found if not s.reachable]

    for source in src.scannable(found):
        if only and source.id != only:
            continue
        stats.sources_scanned += 1
        for path, dir_name in _transcripts(source):
            _ingest_one(conn, source, path, dir_name, stats, full)

    host = next((s for s in found if s.id == "host" and s.reachable), None)
    stats.prompts = _ingest_prompts(conn, host)
    conn.commit()
    return stats
