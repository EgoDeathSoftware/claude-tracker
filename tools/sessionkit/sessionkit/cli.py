"""Command-line entry point for sessionkit.

Read commands refresh the cache incrementally before running, so a skill never has to remember
to ingest first; the refresh is stat-only for unchanged transcripts. Pass ``--no-refresh`` to
skip it when querying a known-current cache in a tight loop.
"""

from __future__ import annotations

import argparse
import re
import sqlite3
import sys
from datetime import datetime, timedelta, timezone

from sessionkit import __version__, cache, ingest, pricing
from sessionkit.classify import classify_error
from sessionkit.render import (BUDGET_AGGREGATE_KB, BUDGET_EXCERPT_KB, BUDGET_INDEX_KB,
                               Report, human_cost)

_DURATION = re.compile(r"^(\d+)\s*([hdw])$", re.I)
_UNITS = {"h": "hours", "d": "days", "w": "weeks"}


def since_cutoff(value: str | None) -> str:
    """Convert a ``7d``/``12h``/``2w`` window into an ISO-8601 cutoff timestamp.

    Args:
        value: Relative duration, or ``None`` for no cutoff.

    Returns:
        An ISO timestamp string, or ``""`` when no cutoff applies.

    Raises:
        SystemExit: If the duration cannot be parsed — a silently-ignored ``--since`` would
            make a partial report look complete.
    """
    if not value:
        return ""
    match = _DURATION.match(value.strip())
    if not match:
        raise SystemExit(f"unrecognised --since value {value!r}; expected e.g. 7d, 12h, 2w")
    amount, unit = int(match.group(1)), match.group(2).lower()
    cutoff = datetime.now(timezone.utc) - timedelta(**{_UNITS[unit]: amount})
    return cutoff.isoformat().replace("+00:00", "Z")


def _filters(args: argparse.Namespace) -> tuple[str, list[str]]:
    """Build a shared WHERE clause from the common filter flags."""
    clauses, params = ["1=1"], []
    cutoff = since_cutoff(getattr(args, "since", None))
    if cutoff:
        clauses.append("s.ended_at >= ?")
        params.append(cutoff)
    if getattr(args, "project", None):
        clauses.append("s.project_key = ?")
        params.append(args.project.lower())
    if getattr(args, "source", None):
        clauses.append("s.source_id = ?")
        params.append(args.source)
    if getattr(args, "state", None):
        clauses.append("s.end_state = ?")
        params.append(args.state)
    mode = getattr(args, "subagents", "include")
    if mode == "exclude":
        clauses.append("s.is_subagent = 0")
    elif mode == "only":
        clauses.append("s.is_subagent = 1")
    return (" AND ".join(clauses), params)


def cmd_doctor(conn: sqlite3.Connection, args: argparse.Namespace) -> str:
    """Report source reachability, cache freshness and corpus totals."""
    report = Report(args.json, args.budget_kb or BUDGET_AGGREGATE_KB)
    report.meta(sessionkit=__version__, cache=str(cache.cache_path()))

    sources = conn.execute("SELECT * FROM sources ORDER BY reachable DESC, id").fetchall()
    report.section("Sources")
    report.table(
        ["id", "kind", "location", "reachable", "root", "note"],
        [[r["id"], r["kind"], r["location"], "yes" if r["reachable"] else "NO",
          r["root"], r["note"]] for r in sources],
        key="sources",
    )
    unreachable = [r["id"] for r in sources if not r["reachable"]]
    if unreachable:
        report.text(f"Not visible from this process: {', '.join(unreachable)}. "
                    "Totals below cover only the reachable sources.")

    totals = conn.execute(
        "SELECT COUNT(*) n, SUM(turns) turns, SUM(cost_usd) cost, "
        "MIN(started_at) first, MAX(ended_at) last FROM sessions"
    ).fetchone()
    errors = conn.execute("SELECT COUNT(*) n FROM tools WHERE is_error=1").fetchone()["n"]
    calls = conn.execute("SELECT COUNT(*) n FROM tools").fetchone()["n"]
    report.section("Corpus")
    report.table(
        ["metric", "value"],
        [["sessions", totals["n"] or 0], ["turns", totals["turns"] or 0],
         ["tool calls", calls], ["failed calls", f"{errors} ({_pct(errors, calls)})"],
         ["est. cost", human_cost(totals["cost"] or 0.0)],
         ["earliest", totals["first"] or "-"], ["latest", totals["last"] or "-"]],
        key="corpus",
    )
    unknown = pricing.unknown_models()
    if unknown:
        report.text(f"Models with no pricing entry (billed at Sonnet default): "
                    f"{', '.join(unknown)}")
    return report.render()


def cmd_ingest(conn: sqlite3.Connection, args: argparse.Namespace) -> str:
    """Refresh the cache from disk."""
    stats = ingest.run(conn, full=args.full, only=args.source)
    report = Report(args.json, args.budget_kb or BUDGET_AGGREGATE_KB)
    report.meta(result=stats.summary())
    if stats.sources_unreachable:
        report.text("Unreachable: " + "; ".join(stats.sources_unreachable))
    return report.render()


def cmd_index(conn: sqlite3.Connection, args: argparse.Namespace) -> str:
    """Layer 1: one line per session."""
    where, params = _filters(args)
    rows = conn.execute(
        f"SELECT s.sid, s.project_key, s.ended_at, s.turns, s.cost_usd, s.end_state, "
        f"s.model, s.source_id, COALESCE(NULLIF(s.title,''), s.first_prompt) label "
        f"FROM sessions s WHERE {where} ORDER BY s.ended_at DESC", params
    ).fetchall()
    report = Report(args.json, args.budget_kb or BUDGET_INDEX_KB)
    report.meta(sessions=len(rows), subagents=args.subagents)
    report.table(
        ["sid", "project", "ended", "turns", "cost", "state", "model", "label"],
        [[r["sid"][:8], r["project_key"], (r["ended_at"] or "")[:16], r["turns"],
          f"{r['cost_usd']:.2f}", r["end_state"], _short_model(r["model"]),
          (r["label"] or "")[:60]] for r in rows],
        key="sessions",
    )
    return report.render()


_GROUP_SQL = {
    "class": "COALESCE(NULLIF(t.err_class,''),'other')",
    "tool": "t.name",
    "signature": "t.err_detail",
    "session": "t.sid",
}


def cmd_errors(conn: sqlite3.Connection, args: argparse.Namespace) -> str:
    """Layer 2: cluster every failed tool call across the fleet.

    This is the skill-facing entry point for ``error-patterns``: it answers "what fails most,
    and what is the fix" without any transcript reaching the caller's context.
    """
    where, params = _filters(args)
    group = _GROUP_SQL[args.group_by]
    rows = conn.execute(
        f"SELECT {group} bucket, COUNT(*) n, COUNT(DISTINCT t.sid) sessions, "
        f"  MIN(t.name) tool, MIN(t.output_preview) exemplar "
        f"FROM tools t JOIN sessions s ON s.sid = t.sid "
        f"WHERE {where} AND (t.is_error=1 OR t.err_class='no-result') "
        f"GROUP BY bucket ORDER BY n DESC", params
    ).fetchall()
    total = sum(r["n"] for r in rows)
    calls = conn.execute(
        f"SELECT COUNT(*) n FROM tools t JOIN sessions s ON s.sid=t.sid WHERE {where}", params
    ).fetchone()["n"]

    report = Report(args.json, args.budget_kb or BUDGET_AGGREGATE_KB)
    report.meta(failures=total, tool_calls=calls, failure_rate=_pct(total, calls),
                grouped_by=args.group_by)
    report.section(f"Failures by {args.group_by}")
    report.table(
        ["bucket", "count", "share", "sessions", "fix", "exemplar"],
        [[r["bucket"] or "-", r["n"], _pct(r["n"], total), r["sessions"],
          classify_error(r["exemplar"])[1][:44], (r["exemplar"] or "")[:60]] for r in rows],
        key="clusters",
    )
    if args.group_by == "class" and rows:
        report.section("Reading this")
        report.text(_headline(conn, rows, total, where, params))
    return report.render()


def _headline(conn: sqlite3.Connection, rows: list[sqlite3.Row], total: int,
              where: str, params: list[str]) -> str:
    """Summarise the clusters, ranking by breadth as well as raw count.

    Count alone is a poor guide to what to fix: ``exit-code`` is usually the largest class but
    is mostly genuine command failures, while a single self-inflicted signature can be smaller
    yet touch far more sessions. Both are reported, plus the dominant single signature — which
    is the level a fix actually lands at.
    """
    top = rows[0]
    widest = max(rows, key=lambda r: r["sessions"])
    sig = conn.execute(
        f"SELECT t.err_detail bucket, COUNT(*) n, COUNT(DISTINCT t.sid) sessions "
        f"FROM tools t JOIN sessions s ON s.sid=t.sid "
        f"WHERE {where} AND t.is_error=1 AND t.err_detail != '' "
        f"GROUP BY bucket ORDER BY n DESC LIMIT 1", params
    ).fetchone()
    total_sessions = conn.execute(
        f"SELECT COUNT(*) n FROM sessions s WHERE {where}", params
    ).fetchone()["n"]

    parts = [f"Largest class is {top['bucket']!r} ({top['n']}/{total}, "
             f"{_pct(top['n'], total)}) across {top['sessions']} session(s)."]
    if widest["bucket"] != top["bucket"]:
        parts.append(f"Widest reach is {widest['bucket']!r}, touching "
                     f"{widest['sessions']}/{total_sessions} sessions — a smaller class that "
                     f"affects more of the fleet is usually the better fix.")
    if sig:
        parts.append(f"Dominant single signature ({sig['n']} failures across "
                     f"{sig['sessions']} sessions): {sig['bucket'][:90]}")
    return " ".join(parts)


def cmd_show(conn: sqlite3.Connection, args: argparse.Namespace) -> str:
    """Layer 3: a surgical excerpt of one session."""
    row = conn.execute(
        "SELECT * FROM sessions WHERE sid LIKE ? ORDER BY ended_at DESC LIMIT 1",
        (args.sid + "%",)
    ).fetchone()
    if row is None:
        raise SystemExit(f"no session matching {args.sid!r} (try `sk index`)")

    report = Report(args.json, args.budget_kb or BUDGET_EXCERPT_KB)
    report.meta(sid=row["sid"], project=row["project_key"], model=row["model"],
                state=row["end_state"], turns=row["turns"],
                cost=human_cost(row["cost_usd"]), path=row["path"])
    if row["end_reason"]:
        report.text(f"End reason: {row['end_reason']}")

    handlers = {"timeline": _show_timeline, "messages": _show_messages,
                "tools": _show_tools, "errors": _show_errors}
    handlers.get(args.mode, _show_summary)(conn, row["sid"], args, report)
    return report.render()


def _show_summary(conn: sqlite3.Connection, sid: str, _args: argparse.Namespace,
                  report: Report) -> None:
    """Anomalies plus tool-usage totals."""
    anomalies = conn.execute(
        "SELECT kind, detail, count, lines FROM anomalies WHERE sid=? ORDER BY count DESC",
        (sid,)).fetchall()
    report.section("Anomalies")
    report.table(["kind", "detail", "count", "lines"],
                 [[a["kind"], a["detail"], a["count"], a["lines"]] for a in anomalies],
                 key="anomalies")
    tools = conn.execute(
        "SELECT name, COUNT(*) n, SUM(is_error) errs FROM tools WHERE sid=? "
        "GROUP BY name ORDER BY n DESC", (sid,)).fetchall()
    report.section("Tools")
    report.table(["tool", "calls", "errors"],
                 [[t["name"], t["n"], t["errs"]] for t in tools], key="tools")


def _show_timeline(conn: sqlite3.Connection, sid: str, _args: argparse.Namespace,
                   report: Report) -> None:
    """Interleaved messages, tool calls and system events in line order."""
    rows = conn.execute(
        "SELECT line, ts, 'msg' kind, role name, preview detail FROM messages WHERE sid=? "
        "UNION ALL SELECT line, ts, 'tool', name, "
        "  CASE WHEN is_error=1 THEN '[' || err_class || '] ' || err_detail "
        "       ELSE input_preview END FROM tools WHERE sid=? "
        "UNION ALL SELECT line, ts, 'sys', subtype, detail FROM sysev WHERE sid=? "
        "ORDER BY line", (sid, sid, sid)).fetchall()
    report.section("Timeline")
    report.table(["line", "kind", "what", "detail"],
                 [[r["line"], r["kind"], r["name"], (r["detail"] or "")[:90]] for r in rows],
                 key="timeline")


def _show_messages(conn: sqlite3.Connection, sid: str, args: argparse.Namespace,
                   report: Report) -> None:
    """A line-numbered range of messages."""
    lo, hi = _range(args.range)
    rows = conn.execute(
        "SELECT line, role, model, text_len, preview FROM messages "
        "WHERE sid=? AND line BETWEEN ? AND ? ORDER BY line", (sid, lo, hi)).fetchall()
    report.section(f"Messages {lo}:{hi}")
    report.table(["line", "role", "chars", "preview"],
                 [[r["line"], r["role"], r["text_len"], r["preview"]] for r in rows],
                 key="messages")


def _show_tools(conn: sqlite3.Connection, sid: str, _args: argparse.Namespace,
                report: Report) -> None:
    """Every tool call in the session."""
    rows = conn.execute(
        "SELECT line, name, dur_ms, is_error, err_class, input_preview FROM tools "
        "WHERE sid=? ORDER BY line", (sid,)).fetchall()
    report.section("Tool calls")
    report.table(["line", "tool", "ms", "err", "input"],
                 [[r["line"], r["name"], r["dur_ms"], r["err_class"] or "",
                   r["input_preview"][:70]] for r in rows], key="tools")


def _show_errors(conn: sqlite3.Connection, sid: str, _args: argparse.Namespace,
                 report: Report) -> None:
    """Only the failing tool calls, with their fix hints."""
    rows = conn.execute(
        "SELECT line, name, err_class, output_preview FROM tools "
        "WHERE sid=? AND (is_error=1 OR err_class='no-result') ORDER BY line",
        (sid,)).fetchall()
    report.section("Errors")
    report.table(["line", "tool", "class", "fix", "detail"],
                 [[r["line"], r["name"], r["err_class"],
                   classify_error(r["output_preview"])[1][:40],
                   (r["output_preview"] or "")[:70]] for r in rows], key="errors")


def _range(value: str | None) -> tuple[int, int]:
    """Parse an ``A:B`` line range."""
    if not value:
        return (1, 10_000)
    parts = value.split(":", 1)
    try:
        lo = int(parts[0]) if parts[0] else 1
        hi = int(parts[1]) if len(parts) > 1 and parts[1] else 10_000
    except ValueError:
        raise SystemExit(f"bad --range {value!r}; expected A:B") from None
    return (lo, hi)


def _pct(part: int, whole: int) -> str:
    """Format a percentage, tolerating a zero denominator."""
    return f"{100.0 * part / whole:.1f}%" if whole else "n/a"


def _short_model(model: str) -> str:
    """Abbreviate a model id for table display."""
    return pricing.normalise(model).replace("claude-", "") or "-"


def build_parser() -> argparse.ArgumentParser:
    """Construct the argument parser for every subcommand."""
    # The global flags live on a parent parser so they are accepted either before or after the
    # subcommand: `sk --json index` and `sk index --json` both work. Skills compose these
    # invocations as strings, and a flag that only parses in one position is a trap.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--json", action="store_true", help="emit JSON instead of text")
    common.add_argument("--budget-kb", type=float, default=0.0,
                        help="cap output size; excess rows are dropped with a notice")
    common.add_argument("--no-refresh", action="store_true",
                        help="skip the incremental cache refresh")

    parser = argparse.ArgumentParser(prog="sk", description=__doc__, parents=[common])
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("doctor", parents=[common],
                   help="source reachability, cache freshness, corpus totals")

    p_ingest = sub.add_parser("ingest", parents=[common], help="refresh the cache from disk")
    p_ingest.add_argument("--full", action="store_true", help="re-parse every transcript")
    p_ingest.add_argument("--source", help="restrict to one source id")

    # Filter flags shared by every query command, so `--since`/`--project`/`--subagents`
    # mean the same thing everywhere.
    scoped = argparse.ArgumentParser(add_help=False)
    for arg in ("--since", "--project", "--source"):
        scoped.add_argument(arg)
    scoped.add_argument("--subagents", choices=["include", "exclude", "only"],
                        default="exclude", help="subagent transcripts (default: exclude)")

    p_index = sub.add_parser("index", parents=[common, scoped],
                             help="one line per session (layer 1)")
    p_index.add_argument("--state", help="filter by end_state, e.g. interrupted-tool")

    p_show = sub.add_parser("show", parents=[common],
                            help="excerpt one session (layer 3)")
    p_show.add_argument("sid", help="session id or unique prefix")
    p_show.add_argument("--mode", default="summary",
                        choices=["summary", "timeline", "messages", "tools", "errors"])
    p_show.add_argument("--range", help="line range for --mode messages, e.g. 40:80")

    p_err = sub.add_parser("errors", parents=[common, scoped],
                           help="cluster tool failures fleet-wide (layer 2)")
    p_err.add_argument("--group-by", choices=["class", "tool", "signature", "session"],
                       default="class")
    return parser


COMMANDS = {"doctor": cmd_doctor, "ingest": cmd_ingest, "index": cmd_index,
            "show": cmd_show, "errors": cmd_errors}


def main(argv: list[str] | None = None) -> int:
    """Entry point. Returns a process exit code."""
    parser = build_parser()
    args = parser.parse_args(argv)
    conn = cache.open_cache()
    try:
        if args.command != "ingest" and not args.no_refresh:
            ingest.run(conn)
        handler = COMMANDS.get(args.command)
        if handler is None:  # pragma: no cover - argparse rejects unknown commands
            parser.error(f"unhandled command {args.command}")
        sys.stdout.write(handler(conn, args))
    finally:
        conn.close()
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
