"""Derived SQLite cache of parsed sessions.

Re-parsing 37 MB of JSONL on every invocation is too slow for an interactive skill, and eleven
skills would otherwise each re-implement the same extraction. :func:`open_cache` gives every
consumer the same normalised tables; :mod:`sessionkit.ingest` keeps them fresh by mtime.

The tracker's own ``tracker.db`` is never written to — it is opened read-only when the FTS
index is wanted (see :func:`open_tracker`).
"""

from __future__ import annotations

import hashlib
import os
import sqlite3
from pathlib import Path

from sessionkit import SCHEMA_VERSION
from sessionkit.classify import Anomaly
from sessionkit.parse import ParsedSession

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);

CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY, kind TEXT, layout TEXT, location TEXT,
    root TEXT, reachable INTEGER, note TEXT, parent_id TEXT, container TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY, source_id TEXT, project_key TEXT, cwd TEXT, path TEXT,
    mtime REAL, bytes INTEGER, git_branch TEXT, version TEXT,
    started_at TEXT, ended_at TEXT, turns INTEGER, model TEXT,
    is_subagent INTEGER, parent_sid TEXT, agent_type TEXT, first_prompt TEXT, title TEXT,
    end_state TEXT, end_reason TEXT, malformed INTEGER,
    cost_usd REAL, tok_in INTEGER, tok_out INTEGER,
    tok_cache_read INTEGER, tok_cache_create INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
    sid TEXT, uuid TEXT, line INTEGER, ts TEXT, role TEXT, model TEXT,
    tok_in INTEGER, tok_out INTEGER, tok_cr INTEGER, tok_cc INTEGER,
    text_len INTEGER, preview TEXT
);

CREATE TABLE IF NOT EXISTS tools (
    sid TEXT, tool_use_id TEXT, line INTEGER, name TEXT, ts TEXT, result_ts TEXT,
    dur_ms INTEGER, is_error INTEGER, err_class TEXT, err_detail TEXT,
    input_digest TEXT, input_preview TEXT, output_preview TEXT, out_bytes INTEGER
);

CREATE TABLE IF NOT EXISTS files (
    sid TEXT, path TEXT, op TEXT, ts TEXT, tool_use_id TEXT
);

CREATE TABLE IF NOT EXISTS sysev (sid TEXT, line INTEGER, ts TEXT, subtype TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS attach (sid TEXT, line INTEGER, ts TEXT, atype TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS anomalies (sid TEXT, kind TEXT, detail TEXT, count INTEGER,
                                      lines TEXT);
CREATE TABLE IF NOT EXISTS prompts (sid TEXT, ts TEXT, project TEXT, text TEXT);

CREATE INDEX IF NOT EXISTS idx_tools_err ON tools(err_class);
CREATE INDEX IF NOT EXISTS idx_tools_sid ON tools(sid, input_digest);
CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
CREATE INDEX IF NOT EXISTS idx_files_sid ON files(sid);
CREATE INDEX IF NOT EXISTS idx_msg_sid ON messages(sid, line);
CREATE INDEX IF NOT EXISTS idx_sessions_end ON sessions(ended_at);
CREATE INDEX IF NOT EXISTS idx_anom_sid ON anomalies(sid);
"""

CHILD_TABLES = ("messages", "tools", "files", "sysev", "attach", "anomalies")


def cache_path() -> Path:
    """Location of the derived cache.

    Kept out of the repository (the toolkit lives in-tree, the cache does not) under
    ``$SESSIONKIT_CACHE`` or the XDG cache directory.
    """
    override = os.environ.get("SESSIONKIT_CACHE")
    if override:
        return Path(override).expanduser()
    base = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
    return base / "sessionkit" / "cache.db"


def open_cache(path: Path | None = None) -> sqlite3.Connection:
    """Open (creating if needed) the derived cache and apply the schema.

    A schema-version bump wipes the cache rather than migrating it — every row is derived and
    can be rebuilt from the transcripts in seconds.
    """
    target = path or cache_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(target))
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    row = conn.execute("SELECT v FROM meta WHERE k='schema_version'").fetchone()
    if row is None:
        conn.execute("INSERT INTO meta(k, v) VALUES('schema_version', ?)",
                     (str(SCHEMA_VERSION),))
        conn.commit()
    elif row["v"] != str(SCHEMA_VERSION):
        _wipe(conn)
        conn.execute("INSERT INTO meta(k, v) VALUES('schema_version', ?)",
                     (str(SCHEMA_VERSION),))
        conn.commit()
    return conn


def _wipe(conn: sqlite3.Connection) -> None:
    """Rebuild the cache from scratch after a schema bump.

    Tables are dropped rather than emptied: a bump usually adds or renames a column, and
    ``CREATE TABLE IF NOT EXISTS`` would leave the old shape in place. Every row here is
    derived, so a full rebuild costs one re-parse of the corpus.
    """
    for table in ("meta", "sessions", "sources", "prompts", *CHILD_TABLES):
        conn.execute(f"DROP TABLE IF EXISTS {table}")
    conn.executescript(SCHEMA)


def open_tracker() -> sqlite3.Connection | None:
    """Open the tracker's own database read-only, or return ``None`` if unavailable.

    Used only for its FTS5 index. Never opened for writing — it belongs to another application.
    """
    path = Path.home() / ".claude" / "tracker" / "tracker.db"
    if not path.is_file():
        return None
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    except sqlite3.Error:
        return None
    conn.row_factory = sqlite3.Row
    return conn


def is_fresh(conn: sqlite3.Connection, sid_path: str, mtime: float, size: int) -> bool:
    """Whether the cached row for a transcript already reflects the file on disk."""
    row = conn.execute(
        "SELECT mtime, bytes FROM sessions WHERE path=?", (sid_path,)
    ).fetchone()
    return row is not None and row["mtime"] == mtime and row["bytes"] == size


def drop_session(conn: sqlite3.Connection, sid: str) -> None:
    """Remove a session and all of its child rows."""
    conn.execute("DELETE FROM sessions WHERE sid=?", (sid,))
    for table in CHILD_TABLES:
        conn.execute(f"DELETE FROM {table} WHERE sid=?", (sid,))


def _disambiguate(conn: sqlite3.Connection, session: ParsedSession) -> None:
    """Suffix a session id that is already claimed by a *different* transcript.

    Session ids are unique per file in practice, but nothing guarantees it — a resumed or
    copied transcript can repeat one. Without this, storing the second file deletes the first
    (child rows are keyed by sid), and the two then re-parse each other forever because
    neither is ever found fresh. The suffix is derived from the path, so it is stable across
    runs and visible in reports rather than silently merging two sessions.
    """
    row = conn.execute("SELECT path FROM sessions WHERE sid=?", (session.sid,)).fetchone()
    if row is not None and row["path"] != session.path:
        tag = hashlib.sha1(session.path.encode("utf-8", "replace")).hexdigest()[:6]
        session.sid = f"{session.sid}#{tag}"


def store(conn: sqlite3.Connection, session: ParsedSession, project: str,
          mtime: float, size: int, anomalies: list[Anomaly]) -> None:
    """Insert (replacing any prior copy of) one parsed session and its child rows."""
    _disambiguate(conn, session)
    drop_session(conn, session.sid)
    conn.execute(
        "INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (session.sid, session.source_id, project, session.cwd, session.path, mtime, size,
         session.git_branch, session.version, session.started_at, session.ended_at,
         session.turns, session.model, int(session.is_subagent), session.parent_sid,
         session.agent_type, session.first_prompt, session.title,
         session.end_state, session.end_reason,
         session.malformed_lines, session.cost_usd, session.tok_in, session.tok_out,
         session.tok_cache_read, session.tok_cache_create),
    )
    conn.executemany(
        "INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        [(session.sid, m.uuid, m.line, m.ts, m.role, m.model, m.tok_in, m.tok_out,
          m.tok_cr, m.tok_cc, m.text_len, m.preview) for m in session.messages],
    )
    conn.executemany(
        "INSERT INTO tools VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [(session.sid, t.tool_use_id, t.line, t.name, t.ts, t.result_ts, t.dur_ms,
          int(t.is_error), t.err_class, t.err_detail, t.input_digest, t.input_preview,
          t.output_preview, t.out_bytes) for t in session.tools],
    )
    conn.executemany(
        "INSERT INTO files VALUES (?,?,?,?,?)",
        [(session.sid, f.path, f.op, f.ts, f.tool_use_id) for f in session.files],
    )
    conn.executemany(
        "INSERT INTO sysev VALUES (?,?,?,?,?)",
        [(session.sid, e.line, e.ts, e.subtype, e.detail) for e in session.sysev],
    )
    conn.executemany(
        "INSERT INTO attach VALUES (?,?,?,?,?)",
        [(session.sid, a.line, a.ts, a.atype, a.detail) for a in session.attach],
    )
    conn.executemany(
        "INSERT INTO anomalies VALUES (?,?,?,?,?)",
        [(session.sid, a.kind, a.detail, a.count,
          ",".join(str(n) for n in a.lines)) for a in anomalies],
    )
