"""sessionkit — fleet-wide analysis of Claude Code sessions.

A zero-dependency toolkit that parses Claude Code / opencode transcripts into a normalised
SQLite cache, then emits compact reports sized for an agent's context window rather than a
human's screen.

See PLAN.md for the three-layer output contract (index / aggregate / excerpt) that every
consumer is expected to descend through.
"""

__version__ = "0.1.0"
SCHEMA_VERSION = 2
