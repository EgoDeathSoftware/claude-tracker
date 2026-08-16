# Audit Report Template

Save the completed report to a file (e.g. `claude-project-audit-<YYYY-MM-DD>.md`) rather than
only replying inline.

```markdown
# Claude Project Audit — <project name> — <date>

## Summary
<2-4 sentences: overall health, biggest cost/failure driver, single highest-impact fix>

## Findings
Ranked by cost/impact, most severe first. One entry per finding:

### <N>. <short title>
- **Dimension:** CLAUDE.md | skills | hooks | permissions | MCP | cost | cache | failure
- **Evidence:** <file:line, session id, or aggregate stat backing this>
- **Impact:** <$ cost, % failure rate, or concrete friction described>
- **Recommendation:** <one concrete, actionable fix>

...

## Data reviewed
- Sessions sampled: <N> (<date range>)
- Data source: tracker API | analyze-sessions.mjs fallback
- Total cost across sampled sessions: $<X>
- Cache hit ratio: <X>%
- Tool error rate: <X>% (worst tool: <name> at <Y>%)
```

Keep findings concrete — no vague "improve context engineering" entries without a specific
file, stat, or session backing them.
