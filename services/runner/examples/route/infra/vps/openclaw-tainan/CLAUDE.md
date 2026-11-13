# CLAUDE.md (fixture: a minimal copy of the model table of dfl-infra:vps/openclaw-tainan/CLAUDE.md)

## Model routing for SUBAGENTS

| Subagent work | Model |
|---|---|
| Planning: plans, analysis, briefs, strategy, ADRs | **`opus`** |
| Complex coding: new design, cross-module change, hard debug, unclear spec | **`opus`** |
| Exploration: read a codebase, read old plans, PRs, logs, transcripts | **`sonnet`** |
| Simple coding, or coding that an earlier plan already defines step by step | **`sonnet`** |
| Planning, when Tainan explicitly asks for Fable | **`fable`** |
| HTML report (brief + data → one page) | **`html-report` skill** |
