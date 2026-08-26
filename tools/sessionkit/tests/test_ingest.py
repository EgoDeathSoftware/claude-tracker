"""End-to-end tests: a synthetic corpus on disk through ingestion to rendered reports."""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from sessionkit import cache, cli, ingest
from tests import fixtures as fx


class CorpusTest(unittest.TestCase):
    """Ingest a controlled corpus and query it through the CLI."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)
        self.home = self.tmp / "claude"
        self.home.mkdir()

        # An empty env file so the repo's real .env (which names another user's paths) is not
        # picked up and the only configured source is our temp one.
        env_file = self.tmp / "empty.env"
        env_file.write_text("", encoding="utf-8")
        patcher = mock.patch.dict(os.environ, {
            "CLAUDE_DIR": str(self.home),
            "SESSIONKIT_ENV": str(env_file),
            "SESSIONKIT_CACHE": str(self.tmp / "cache.db"),
        })
        patcher.start()
        self.addCleanup(patcher.stop)

        self.conn = cache.open_cache()
        self.addCleanup(self.conn.close)

    def _write_corpus(self) -> None:
        """A healthy session, a hook-blocked session, and a subagent."""
        fx.write(self.home, fx.simple_session(), name="aaaa1111.jsonl")
        fx.write(self.home, [
            fx.user("search the repo"),
            fx.assistant([fx.tool_use("t1", "Bash", {"command": "grep -r x ."})]),
            fx.tool_result("t1", "BLOCKED: Use rg (ripgrep) instead of grep", is_error=True),
            fx.assistant([fx.tool_use("t2", "Bash", {"command": "find . -name x"})],
                         ts="2026-08-01T00:00:05Z"),
            fx.tool_result("t2", "BLOCKED: Use fd instead of find", is_error=True,
                           ts="2026-08-01T00:00:06Z"),
        ], name="bbbb2222.jsonl")
        fx.write_subagent(self.home, fx.simple_session(), agent_id="cccc3333")

    def test_ingest_counts_every_file_including_subagents(self) -> None:
        self._write_corpus()
        stats = ingest.run(self.conn)
        self.assertEqual(stats.parsed, 3, "the nested subagent transcript must be found")
        self.assertEqual(stats.failed, 0)

    def test_second_pass_reparses_nothing(self) -> None:
        self._write_corpus()
        ingest.run(self.conn)
        stats = ingest.run(self.conn)
        self.assertEqual(stats.parsed, 0)
        self.assertEqual(stats.skipped, 3)

    def test_changed_file_is_reparsed(self) -> None:
        self._write_corpus()
        ingest.run(self.conn)
        path = self.home / "projects" / "-home-dev-myproject" / "aaaa1111.jsonl"
        path.write_text(path.read_text() + json.dumps(fx.user("more")) + "\n",
                        encoding="utf-8")
        self.assertEqual(ingest.run(self.conn).parsed, 1)

    def test_unreachable_sources_are_reported_not_hidden(self) -> None:
        self._write_corpus()
        with mock.patch.dict(os.environ, {"CLAUDE_DIR_WSL": "/nonexistent/elsewhere"}):
            stats = ingest.run(self.conn)
        self.assertTrue(any("wsl" in note for note in stats.sources_unreachable))

    def test_colliding_session_ids_keep_separate_rows(self) -> None:
        """Two transcripts sharing a sessionId must not overwrite one another."""
        self._write_corpus()
        ingest.run(self.conn)
        rows = self.conn.execute(
            "SELECT sid, path FROM sessions WHERE is_subagent=0").fetchall()
        self.assertEqual(len(rows), 2)
        self.assertEqual(len({r["sid"] for r in rows}), 2, "ids must be disambiguated")
        self.assertEqual(len({r["path"] for r in rows}), 2)

    def test_subagent_gets_its_own_row_and_parent_link(self) -> None:
        self._write_corpus()
        ingest.run(self.conn)
        row = self.conn.execute(
            "SELECT sid, parent_sid, agent_type, is_subagent FROM sessions "
            "WHERE is_subagent=1").fetchone()
        self.assertEqual(row["sid"], "cccc3333")
        self.assertEqual(row["parent_sid"], fx.SID)
        self.assertEqual(row["agent_type"], "Explore")

    def test_sessions_share_a_project_key(self) -> None:
        self._write_corpus()
        ingest.run(self.conn)
        keys = {r["project_key"] for r in
                self.conn.execute("SELECT DISTINCT project_key FROM sessions")}
        self.assertEqual(keys, {"myproject"})

    def test_index_excludes_subagents_by_default(self) -> None:
        self._write_corpus()
        ingest.run(self.conn)
        args = cli.build_parser().parse_args(["index"])
        self.assertNotIn("cccc3333", cli.cmd_index(self.conn, args))
        args = cli.build_parser().parse_args(["index", "--subagents", "only"])
        self.assertIn("cccc3333", cli.cmd_index(self.conn, args))

    def test_errors_report_ranks_hook_blocks_first(self) -> None:
        self._write_corpus()
        ingest.run(self.conn)
        args = cli.build_parser().parse_args(["errors", "--subagents", "include"])
        report = cli.cmd_errors(self.conn, args)
        self.assertIn("hook-block", report)
        self.assertIn("Promote the rule into CLAUDE.md", report)

    def test_errors_json_mode_is_machine_readable(self) -> None:
        self._write_corpus()
        ingest.run(self.conn)
        args = cli.build_parser().parse_args(["errors", "--json"])
        doc = json.loads(cli.cmd_errors(self.conn, args))
        self.assertEqual(doc["failures"], 2)
        self.assertEqual(doc["clusters"][0]["bucket"], "hook-block")

    def test_doctor_names_the_sources_it_cannot_see(self) -> None:
        self._write_corpus()
        with mock.patch.dict(os.environ, {"CLAUDE_DIR_WINDOWS": "/nope"}):
            ingest.run(self.conn)
            args = cli.build_parser().parse_args(["doctor"])
            report = cli.cmd_doctor(self.conn, args)
        self.assertIn("windows", report)
        self.assertIn("Not visible from this process", report)

    def test_show_rejects_unknown_session(self) -> None:
        args = cli.build_parser().parse_args(["show", "nope"])
        with self.assertRaises(SystemExit):
            cli.cmd_show(self.conn, args)

    def test_empty_corpus_does_not_crash(self) -> None:
        stats = ingest.run(self.conn)
        self.assertEqual(stats.parsed, 0)
        args = cli.build_parser().parse_args(["index"])
        self.assertIn("sessions=0", cli.cmd_index(self.conn, args))


class SinceTest(unittest.TestCase):
    """--since parsing must fail loudly rather than silently ignoring a bad window."""

    def test_valid_windows(self) -> None:
        for value in ("7d", "12h", "2w", " 3d "):
            self.assertTrue(cli.since_cutoff(value))

    def test_absent_window_means_no_cutoff(self) -> None:
        self.assertEqual(cli.since_cutoff(None), "")

    def test_bad_window_raises(self) -> None:
        with self.assertRaises(SystemExit):
            cli.since_cutoff("last tuesday")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
