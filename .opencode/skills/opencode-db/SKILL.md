---
name: opencode-db
description: Query opencode's local SQLite session database (opencode.db) directly and read-only via the db_query, db_read_session, and db_search plugin tools, or raw sqlite3. Use for exploring session history - finding sessions, reading conversations, searching content, tool-call history, todos, cost and token rollups. Provides schema knowledge (tables, JSON shapes, indexes), safe read-only patterns, and fast query recipes.
metadata:
  opencode/slash: "false"
---

# opencode session database

opencode stores all sessions, messages, and parts in a single SQLite database:

- Path, first that applies: `$OPENCODE_DB_PATH`, then `opencode db path`, then `${XDG_DATA_HOME ?? ~/.local/share}/opencode/opencode.db`
- ~14 GB, WAL mode, actively written by the running opencode server
- Scale (2026-10): ~5,400 sessions, 460 projects, 127K messages, 559K parts

Everything here is **read-only**. WAL readers never block the live writer, so queries of any length are safe. The db_* tools enforce read-only at the SQLite engine level — writes are impossible, not merely discouraged.

## Tool selection

| Need | Use |
|---|---|
| Read a session's conversation | `db_read_session(session_id)` — ms, any session size |
| Find sessions by title | `db_search(query, scope="titles")` — instant |
| Search inside one session | `db_search(query, session_id, scope="session")` — ms |
| Search everything | `db_search(query, scope="global")` — full scan, 10–30 s |
| Anything structured (counts, joins, rollups, tool history, todos) | `db_query(sql)` |
| Pipe output through jq/rg, or db_* tools unavailable | raw `sqlite3` (below) |

Prefer the db_* tools over the older `search_sessions`/`list_sessions` (API-based, session-by-session HTTP calls — orders of magnitude slower). The db_* tools bypass the API entirely and talk to the database directly.

## Search strategy: narrow before scanning

Queries match **all words**: `db_search("auth login")` finds parts (or titles) containing both `auth` and `login`, in any order. Wrap a phrase in double quotes to match it exactly: `"connection refused" retry`. Each extra word narrows the results; it doesn't widen them.

1. `db_search(query, scope="titles")` — instant title lookup.
2. Narrow by project/directory/date via `db_query` (indexed, ms).
3. `db_search(query, session_id=..., scope="session")` — ms.
4. `db_search(query, scope="global")` — last resort, 10–30 s budget. Only when the term could be anywhere and narrower scopes failed.

## Raw sqlite3 escape hatch

Use when you need `jq`/`rg` composition, streaming, or the db_* tools are not loaded (no restart needed — unlike plugin changes):

```bash
sqlite3 -readonly "file:$(opencode db path)?mode=ro" \
  "SELECT ... ;" 
```

Or interactively: `sqlite3 -readonly "$(opencode db path)"`

Rules:
- Always `mode=ro` (URI) or `-readonly` (flag).
- **Never** `immutable=1` — it ignores the `-wal` file and returns stale data.
- Add `.timeout 5000` in interactive sessions.
- Do not run `PRAGMA wal_checkpoint`, `VACUUM`, or write `ATTACH` — they fight the live writer (and fail on read-only connections anyway).

## Schema

```
project 1─* session 1─* message 1─* part
session 1─* todo, session_input, session_share, session_context_epoch
```

- `session` — id, project_id, parent_id, slug, directory, title, workspace_id, agent, model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated, time_compacting, time_archived, metadata
- `message` — id, session_id, time_created, time_updated, `data` (JSON)
- `part` — id, message_id, session_id, time_created, time_updated, `data` (JSON)
- `project` — id, worktree, vcs, name, time_created
- `todo` — (session_id, position) pk, content, status, priority
- `session_input` — id, session_id, prompt, delivery, time_created
- `workspace` — id, type, name, branch, directory, project_id
- `project_directory` — (project_id, directory) pk, type, strategy
- `event`, `session_message` — audit/event-sourcing logs. **Ignore for exploration.**

### JSON shapes

`message.data`: `{parentID, role, mode, agent, path: {cwd, root}, cost, tokens: {...}}`

`part.data`, by `type`:
- `"text"` / `"reasoning"`: `{type, text}`
- `"tool"`: `{type, tool, callID, state: {status, input, output, error, ...}}`
- `"step-start"`: `{type, snapshot}`

**Hazard:** tool part outputs can be megabytes each. Never `SELECT data FROM part` unbounded — 559K parts × MBs. Always `substr(...)` or `json_extract(...)` with a length cap (the db_* tools cap automatically).

### Facts that matter

- Timestamps are epoch **milliseconds** (`datetime(time_created/1000, 'unixepoch')` to render).
- IDs are strings: `ses_...`, `msg_...`, `prt_...`, `prj_...`.
- Useful indexes: `part(session_id)`, `part(message_id, id)`, `message(session_id, time_created, id)`, `session(project_id)`, `session(parent_id)`, `session(workspace_id)`.
- `part.id` embeds creation time — sorts roughly chronologically within a message.

## Recipes (db_query)

Schema dump:

```sql
SELECT sql FROM sqlite_master WHERE type = 'table' AND name NOT IN ('event', 'session_message')
```

Project for the current working directory, then its sessions:

```sql
SELECT id, name FROM project WHERE id IN (SELECT project_id FROM project_directory WHERE directory = '<cwd>')
```

```sql
SELECT id, title, datetime(time_created/1000, 'unixepoch') AS created, cost
FROM session WHERE project_id = '<prj_id>'
ORDER BY time_created DESC LIMIT 20
```

Sessions mentioning a term in the title (instant):

```sql
SELECT id, title, directory FROM session WHERE title LIKE '%<term>%' ORDER BY time_updated DESC
```

Child sessions of a parent (subagents):

```sql
SELECT id, title, agent FROM session WHERE parent_id = '<ses_id>' ORDER BY time_created
```

Tool-call history for a session:

```sql
SELECT json_extract(p.data, '$.tool') AS tool,
       json_extract(p.data, '$.state.status') AS status,
       substr(coalesce(json_extract(p.data, '$.state.input'), ''), 1, 200) AS input
FROM part p WHERE p.session_id = '<ses_id>'
  AND json_extract(p.data, '$.type') = 'tool'
ORDER BY p.time_created LIMIT 50
```

Todos for a session:

```sql
SELECT position, status, substr(content, 1, 120) FROM todo WHERE session_id = '<ses_id>' ORDER BY position
```

Cost rollup by project:

```sql
SELECT p.name, count(*) AS sessions, round(sum(s.cost), 2) AS total_cost,
       sum(s.tokens_input + s.tokens_output) AS tokens
FROM session s JOIN project p ON p.id = s.project_id
GROUP BY p.id ORDER BY total_cost DESC LIMIT 10
```

Sessions per day (activity histogram):

```sql
SELECT date(time_created/1000, 'unixepoch') AS day, count(*) AS n
FROM session GROUP BY day ORDER BY day DESC LIMIT 30
```

## Performance rules

- Indexed drill-downs (session → messages → parts): 5–40 ms.
- `count(*)` on core tables: ~1 s. Group-bys over `event` (1.6M rows): ~2 s.
- Any `LIKE '%...%'` over all of `part.data`: 10–30 s. Full scan — unavoidable without FTS. Budget it, cap `limit`.
- When a query is slow unexpectedly, check the plan: `EXPLAIN QUERY PLAN <query>` — look for `SCAN part` vs `SEARCH part USING INDEX`.
- Filter by indexed columns first (`session_id`, `message_id`, `project_id`, `time_created` ranges), then apply JSON extraction.
- `json_extract` on every row of a big table is a full scan plus JSON parsing — always narrow by index first, or substr() cap the extraction.
