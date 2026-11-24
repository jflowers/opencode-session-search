# Plan: `opencode-db` — plugin tools + skill for direct SQLite exploration

**Date:** 2026-10-13
**Status:** Approved, ready to implement
**Repo:** `opencode-session-search` (already globally registered as a plugin in `~/.config/opencode/opencode.jsonc`)

## Goal

Give agents the ability to explore opencode's session database directly — effectively, efficiently, and safely — via read-only SQL. Complements the existing SDK/API-based `search_sessions` and `list_sessions` tools with a dramatically faster path that bypasses the HTTP client entirely.

## Research findings (measured 2026-10-13)

These facts drive the design and should be preserved in the SKILL.md knowledge layer.

### The database

- Path: `${XDG_DATA_HOME ?? ~/.local/share}/opencode/opencode.db`
- Size: ~14 GB, WAL mode, live writer (opencode server)
- Scale: ~5,351 sessions, 459 projects, 127K messages, 558K parts, 1.6M events

### Schema (core tables for exploration)

```
project 1─* session 1─* message 1─* part
session 1─* todo, session_input, session_share, session_context_epoch
```

- `session`: id, project_id, parent_id, slug, directory, title, version, share_url, time_created, time_updated, time_compacting, time_archived, workspace_id, path, agent, model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, metadata
- `message`: id, session_id, time_created, time_updated, `data` (JSON)
- `part`: id, message_id, session_id, time_created, time_updated, `data` (JSON)
- `project`: id, worktree, vcs, name, icon_url, time_created, ...
- `todo`: (session_id, position) pk, content, status, priority
- `session_input`: id, session_id, prompt, delivery, admitted_seq, promoted_seq, time_created
- `workspace`: id, type, name, branch, directory, project_id
- `project_directory`: (project_id, directory) pk, type, strategy
- `event` / `session_message`: audit/event-sourcing logs — **ignore for exploration**

### JSON shapes of `data` columns

- `message.data`: `{parentID, role, mode, agent, path: {cwd, root}, cost, tokens: {...}}`
- `part.data`: `{type: "text"|"reasoning", text}` | `{type: "tool", tool, callID, state: {...}}` | `{type: "step-start", snapshot}`
  - Tool part outputs can be **megabytes each** — unbounded `SELECT data` from `part` is the #1 hazard

### Available indexes

- `part(session_id)`
- `part(message_id, id)`
- `message(session_id, time_created, id)`
- `session(project_id)`, `session(parent_id)`, `session(workspace_id)`
- `session_message(time_created)`

### Measured performance

| Operation | Time |
|---|---|
| Indexed drill-down (session → messages → parts) | 5–40 ms |
| `count(*)` across all core tables | ~1.2 s |
| `event` GROUP BY type (1.6M rows) | ~1.8 s |
| Full-db `LIKE '%...%'` scan over `part.data` | ~16 s (last resort, budget 15–30 s) |
| Existing `search_sessions` (API, session-by-session) | far slower; the motivation for this work |

### Safety facts

- Always open read-only: `sqlite3 "file:...?mode=ro"` URI or `-readonly` flag
- Never `immutable=1` — it ignores the `-wal` file → stale reads
- WAL readers never block the live writer; long read queries are safe
- Forbidden on the live db: writes, `PRAGMA wal_checkpoint`, `VACUUM`, write `ATTACH`
- Timestamps are epoch **milliseconds**

## Architecture decision

**Chosen: plugin tools + SKILL.md knowledge layer.**

Rationale:
- Distribution already solved — this repo is a globally registered plugin; new tools ship everywhere with zero setup
- No shell-quoting hazards — SQL arrives as a JSON string arg
- Runs in the server process — works regardless of agent bash context (e.g., future sandboxing)
- Per-tool permission integration possible
- `bun:sqlite` is built into the runtime — zero new dependencies, real JSON parsing, testable

Rejected alternatives:
- Bash script (`ocdb` wrapper) — faster iteration, unix composability, but quoting fragility, symlink needed for global reach, sandbox-fragile
- Sidecar FTS5 index — out of scope for the chosen purpose (agent exploration, not search acceleration)

The SKILL.md still documents raw `sqlite3` as the escape hatch (no restart needed, composes with `jq`/`rg`), so the curated tool surface can stay minimal.

## Deliverables

### 1. `src/db.ts` (new module)

- `openDB()` — resolves `${XDG_DATA_HOME ?? ~/.local/share}/opencode/opencode.db`, opens via `bun:sqlite` `Database` with `{ readonly: true }`, per-call open/close (no held handles against the live db)
- Shared helpers: row capping, value truncation, single-statement enforcement, keyword blocklist (`ATTACH`, `VACUUM`, `PRAGMA` writes) as defense in depth behind the read-only connection

### 2. Three plugin tools (registered in `src/index.ts`)

Deliberately minimal surface — everything else becomes SKILL.md recipes over `db_query`, keeping per-session context cost low.

| Tool | Args | Behavior | Cost |
|---|---|---|---|
| `db_query` | `sql`, `max_rows?` | Arbitrary single-statement SQL, read-only enforced at engine level | varies |
| `db_read_session` | `session_id`, `types?`, `limit?`, `chars_per_part?` | message⋈part join, `json_extract` for text/reasoning/tool parts, ordered by existing composite indexes | ms |
| `db_search` | `query`, `session_id?`, `scope?` | Tiered: titles → session-scoped LIKE → global LIKE; description carries the "~15–30s" budget warning | ms → ~16 s |

Why these three:
- `db_read_session`: the join + JSON extraction is the one genuinely painful raw-SQL recipe (~400 chars of SQL vs a 30-char tool call, used constantly)
- `db_search`: the tiered-narrowing logic is real code, not a query
- `db_query`: maximum flexibility escape hatch with engine-level read-only safety

Existing `search_sessions`/`list_sessions` stay untouched.

### 3. `.opencode/skills/opencode-db/SKILL.md` + global symlink

- `ln -s <repo>/.opencode/skills/opencode-db ~/.config/opencode/skills/opencode-db` (single source of truth)

SKILL.md outline:
1. Frontmatter: `name: opencode-db`, description (when to load), `opencode/slash: "false"`
2. Tool selection guide — db_* tools preferred over legacy API-scanning tools
3. Raw `sqlite3` escape hatch — read-only URI pattern, never `immutable=1`, when to prefer it
4. Schema reference — ER summary, JSON shapes, indexes, epoch-millis, ignore `event`/`session_message`
5. Copy-paste recipes over `db_query` — schema dump, project-for-cwd, recent sessions, tool-call history, todos, cost rollups
6. Performance rules — measured timings, `EXPLAIN QUERY PLAN`, never raw `SELECT data` from `part`

### 4. `src/db.test.ts`

Bun's built-in test runner (zero config). Read-only tests against the real db:
- Readonly open works with live WAL
- Single-statement enforcement
- Keyword blocklist
- Row cap / value truncation
- `db_read_session` output shape

## Verification

1. `bun x tsc --noEmit`
2. `bun test`
3. Restart opencode → confirm the three tools register → one live call each
4. SKILL.md frontmatter validation (name matches dir, description 1–1024 chars, name regex `^[a-z0-9]+(-[a-z0-9]+)*$`)

## Notes and risks

- Plugin changes require an opencode **restart** to take effect
- `bun:sqlite` `{ readonly: true }` + live WAL: verified conceptually via CLI; confirm in tests
- `db_query` bypasses the SDK/API layer — read-only is the safety story; state this explicitly in the skill
- Multi-statement SQL is rejected by `prepare()`; blocklist adds defense in depth

## Out of scope / future options

- Rewrite `search_sessions`/`list_sessions` internals on direct SQL (same interface, ~1000x faster)
- Description tweak on legacy tools to route agents toward the fast path
- Sidecar FTS5 index for instant global full-text search
