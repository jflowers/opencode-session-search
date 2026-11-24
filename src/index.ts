import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
import * as db from "./db"

type Depth = "conversation" | "tool" | "both"

const SNIPPET_RADIUS = 80

type SessionMeta = {
  id: string
  title: string
  created: number
  agent?: string
  model?: string
  parentID?: string
}

type Match = {
  role: string
  snippet: string
  timestamp: number
}

type SessionResult = {
  sessionID: string
  title: string
  date: string
  agent?: string
  model?: string
  matches: Match[]
}

function extractPartTexts(part: any, depth: Depth): string[] {
  const texts: string[] = []
  const includeConversation = depth === "conversation" || depth === "both"
  const includeTool = depth === "tool" || depth === "both"

  switch (part.type) {
    case "text":
      if (includeConversation && part.text) texts.push(part.text)
      break

    case "reasoning":
      if (includeConversation && part.text) texts.push(part.text)
      break

    case "tool":
      if (includeTool && part.state) {
        const state = part.state
        if (state.input && typeof state.input === "object") {
          texts.push(JSON.stringify(state.input))
        }
        if (state.status === "pending" && state.raw) texts.push(state.raw)
        if (state.status === "completed" && state.output) texts.push(state.output)
        if (state.status === "error" && state.error) texts.push(state.error)
      }
      break
  }

  return texts
}

function buildSnippet(text: string, query: string): string | null {
  const lower = text.toLowerCase()
  const idx = lower.indexOf(query)
  if (idx === -1) return null

  const start = Math.max(0, idx - SNIPPET_RADIUS)
  const end = Math.min(text.length, idx + query.length + SNIPPET_RADIUS)
  let snippet = text.slice(start, end).replace(/\n/g, " ")
  if (start > 0) snippet = "..." + snippet
  if (end < text.length) snippet = snippet + "..."
  return snippet
}

async function scanSession(
  client: any,
  sessionID: string,
  query: string,
  depth: Depth,
): Promise<Match[]> {
  const matches: Match[] = []

  try {
    const result = await client.session.messages({ path: { id: sessionID } })
    if (!result.data) return matches

    for (const entry of result.data) {
      const role = entry.info?.role ?? "unknown"
      const timestamp = entry.info?.time?.created ?? 0

      for (const part of entry.parts ?? []) {
        const texts = extractPartTexts(part, depth)
        for (const text of texts) {
          const snippet = buildSnippet(text, query)
          if (snippet) {
            matches.push({ role, snippet, timestamp })
          }
        }
      }
    }
  } catch {
    // Skip sessions that can't be read (e.g. deleted, corrupted)
  }

  return matches
}

/** Normalize any session-shaped object into SessionMeta. */
function mapSession(s: any): SessionMeta {
  return {
    id: s.id,
    title: s.title ?? "Untitled",
    created: s.time?.created ?? 0,
    agent: s.agent ?? undefined,
    model: typeof s.model === "string" ? s.model : (s.model?.id ?? undefined),
    parentID: s.parentID ?? s.parent_id ?? undefined,
  }
}

/** Resolve a single session ID into SessionMeta via the SDK. */
async function resolveSessionMeta(client: any, sessionID: string): Promise<SessionMeta> {
  try {
    const info = await client.session.get({ path: { id: sessionID } })
    if (info.data) {
      return mapSession(info.data)
    }
  } catch {
    // Fall back to minimal metadata
  }
  return { id: sessionID, title: sessionID, created: 0 }
}

async function fetchGlobalSessions(
  client: any,
  maxSessions: number,
): Promise<SessionMeta[]> {
  const sessions: SessionMeta[] = []
  let cursor: string | undefined
  // Access the underlying HTTP client which carries the in-process fetch shim.
  const httpClient = (client as any)._client

  while (sessions.length < maxSessions) {
    const query: Record<string, string> = {
      roots: "true",
      limit: String(Math.min(maxSessions - sessions.length, 50)),
      // Pass empty directory so the SDK rewrite interceptor skips injecting
      // the project directory, while the server treats "" as falsy (no filter).
      directory: "",
    }
    if (cursor) query.cursor = cursor

    const result = await httpClient.get({
      url: "/experimental/session",
      query,
    })

    const data = result.data
    if (!Array.isArray(data)) break

    for (const s of data) {
      sessions.push(mapSession(s))
    }

    const nextCursor = result.response?.headers?.get("x-next-cursor")
    if (!nextCursor) break
    cursor = nextCursor
  }

  return sessions
}

/** Fetch all local sessions via the SDK client. */
async function fetchLocalSessions(client: any): Promise<SessionMeta[]> {
  const result = await client.session.list()
  const sessions = (result.data ?? []).map(mapSession)
  sessions.sort((a: SessionMeta, b: SessionMeta) => b.created - a.created)
  return sessions
}

function formatResults(results: SessionResult[]): string {
  if (results.length === 0) return "No matches found."

  const totalMatches = results.reduce((sum, r) => sum + r.matches.length, 0)
  const lines: string[] = [
    `Found ${totalMatches} match${totalMatches === 1 ? "" : "es"} across ${results.length} session${results.length === 1 ? "" : "s"}:`,
    "",
  ]

  for (const result of results) {
    lines.push(
      `## ${result.title} (${result.date}) — ${result.matches.length} match${result.matches.length === 1 ? "" : "es"}`,
    )
    lines.push(`Session ID: ${result.sessionID}`)
    if (result.agent) lines.push(`Agent: ${result.agent}`)
    if (result.model) lines.push(`Model: ${result.model}`)
    for (const match of result.matches.slice(0, 5)) {
      lines.push(`- [${match.role}] ${match.snippet}`)
    }
    if (result.matches.length > 5) {
      lines.push(`- ... and ${result.matches.length - 5} more matches`)
    }
    lines.push("")
  }

  return lines.join("\n")
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function formatDbModel(model: db.SqlValue): string | null {
  if (model === null) return null
  const raw = String(model)
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === "object" && parsed !== null && typeof parsed.id === "string" ? parsed.id : raw
  } catch {
    return raw
  }
}

function formatDbSessionRead(result: db.ReadSessionResult): string {
  const s = result.session
  const lines: string[] = [`## ${s.title ?? "Untitled"}`, `Session: ${s.id}`]
  if (s.directory) lines.push(`Directory: ${s.directory}`)
  const idents: string[] = []
  if (s.agent) idents.push(`Agent: ${s.agent}`)
  const model = formatDbModel(s.model)
  if (model) idents.push(`Model: ${model}`)
  if (idents.length > 0) lines.push(idents.join(" | "))
  lines.push(`Created: ${formatDate(s.timeCreated)} | Updated: ${formatDate(s.timeUpdated)}`)
  if (s.cost !== null) {
    lines.push(`Cost: $${Number(s.cost).toFixed(4)} | Tokens in/out: ${s.tokensInput ?? 0}/${s.tokensOutput ?? 0}`)
  }
  lines.push(`Parts: ${result.parts.length}${result.truncated ? " (truncated — raise limit for more)" : ""}`)
  lines.push("")
  for (const part of result.parts) {
    const time = new Date(part.timeCreated).toISOString().slice(11, 19)
    const label = part.tool
      ? `${part.role ?? "?"}/${part.type ?? "?"} ${part.tool}${part.status ? ` → ${part.status}` : ""}`
      : `${part.role ?? "?"}/${part.type ?? "?"}`
    lines.push(`[${time} ${label}]`)
    if (part.text) lines.push(String(part.text))
    if (part.toolOutput) lines.push(String(part.toolOutput))
    lines.push("")
  }
  return lines.join("\n")
}

function formatDbSearch(result: db.SearchResult): string {
  const header =
    `Scope: ${result.scope} | Term: "${result.term}" | ` +
    `${result.matches.length} match${result.matches.length === 1 ? "" : "es"} in ${result.elapsedMs} ms` +
    (result.truncated ? " (capped at limit)" : "")
  if (result.matches.length === 0) return `${header}\n\nNo matches found.`
  const lines: string[] = [header, ""]
  for (const m of result.matches) {
    const date = new Date(m.timeCreated).toISOString().slice(0, 16).replace("T", " ")
    if (result.scope === "titles") {
      lines.push(`## ${m.title ?? "Untitled"} (${date}) — ${m.sessionId}`)
      if (m.directory) lines.push(`Directory: ${m.directory}`)
    } else {
      lines.push(`- ${date} [${m.role ?? "?"}/${m.type ?? "?"}] ${m.title ?? "Untitled"} — ${m.sessionId}`)
      if (m.directory) lines.push(`  ${m.directory}`)
      if (m.snippet) lines.push(`  ${String(m.snippet).replace(/\s+/g, " ").trim()}`)
    }
  }
  return lines.join("\n")
}

function formatSessionList(sessions: SessionMeta[]): string {
  if (sessions.length === 0) return "No sessions found."

  const lines: string[] = [
    `Found ${sessions.length} session${sessions.length === 1 ? "" : "s"}:`,
    "",
  ]

  for (const s of sessions) {
    lines.push(`## ${s.title}`)
    lines.push(`ID: ${s.id}`)
    lines.push(`Created: ${formatDate(s.created)}`)
    if (s.parentID) lines.push(`Parent: ${s.parentID}`)
    if (s.agent) lines.push(`Agent: ${s.agent}`)
    if (s.model) lines.push(`Model: ${s.model}`)
    lines.push("")
  }

  return lines.join("\n")
}

const plugin: Plugin = async (ctx) => ({
  tool: {
    search_sessions: tool({
      description:
        "Search past session history by message content. " +
        "Scans session messages for a text query and returns matching snippets. " +
        "Use to recall previous conversations, find when a topic was discussed, " +
        "or locate past solutions. " +
        "Pass session_id or session_ids to target specific sessions. " +
        "Pass parent_session_id to search only child sessions of a parent.",
      args: {
        query: tool.schema.string().describe("Search term (case-insensitive substring match)"),
        session_id: tool.schema
          .string()
          .optional()
          .describe(
            "Search only this specific session (by session ID). " +
              "When set, session_ids, parent_session_id, global, and max_sessions are ignored.",
          ),
        session_ids: tool.schema
          .array(tool.schema.string())
          .optional()
          .describe(
            "Search a specific set of sessions by ID. " +
              "When set, parent_session_id, global, and max_sessions are ignored.",
          ),
        parent_session_id: tool.schema
          .string()
          .optional()
          .describe(
            "Search only child sessions of this parent session ID. " +
              "Lists sessions and filters to those whose parentID matches. " +
              "Combines with global to search children across all projects.",
          ),
        global: tool.schema
          .boolean()
          .optional()
          .describe("Search across all projects instead of just the current one (default: false)"),
        depth: tool.schema
          .enum(["conversation", "tool", "both"])
          .optional()
          .describe(
            'What to search: "conversation" for user/assistant text (default), ' +
              '"tool" for tool inputs/outputs, "both" for everything',
          ),
        limit: tool.schema
          .number()
          .optional()
          .describe("Max sessions to return in results (default: 5)"),
        max_sessions: tool.schema
          .number()
          .optional()
          .describe("Max sessions to scan (default: 20)"),
      },
      async execute(args) {
        const query = args.query.toLowerCase()
        const depth: Depth = args.depth ?? "conversation"
        const limit = args.limit ?? 5
        const maxSessions = args.max_sessions ?? 20

        let sessions: SessionMeta[]

        if (args.session_id) {
          // Single session — resolve metadata, ignore other filters
          sessions = [await resolveSessionMeta(ctx.client, args.session_id)]
        } else if (args.session_ids && args.session_ids.length > 0) {
          // Batch of specific sessions — resolve each in parallel
          sessions = await Promise.all(
            args.session_ids.map((id) => resolveSessionMeta(ctx.client, id)),
          )
        } else if (args.parent_session_id) {
          // Find children of a parent — fetch all, then filter by parentID
          const allSessions = args.global
            ? await fetchGlobalSessions(ctx.client, 500)
            : await fetchLocalSessions(ctx.client)
          sessions = allSessions.filter((s) => s.parentID === args.parent_session_id)
        } else if (args.global) {
          sessions = await fetchGlobalSessions(ctx.client, maxSessions)
        } else {
          const allSessions = await fetchLocalSessions(ctx.client)
          sessions = allSessions.slice(0, maxSessions)
        }

        const results: SessionResult[] = []

        for (const session of sessions) {
          const matches = await scanSession(ctx.client, session.id, query, depth)
          if (matches.length > 0) {
            results.push({
              sessionID: session.id,
              title: session.title,
              date: formatDate(session.created),
              agent: session.agent,
              model: session.model,
              matches,
            })
          }
        }

        results.sort((a, b) => b.matches.length - a.matches.length)
        const topResults = results.slice(0, limit)
        const totalMatches = topResults.reduce((sum, r) => sum + r.matches.length, 0)

        return {
          title: `Searched ${sessions.length} sessions, found ${totalMatches} matches in ${topResults.length} sessions`,
          output: formatResults(topResults),
          metadata: {
            scanned: sessions.length,
            matchingSessions: topResults.length,
            totalMatches,
          },
        }
      },
    }),

    list_sessions: tool({
      description:
        "List sessions with metadata (title, agent, model, parent ID). " +
        "Use to discover session IDs, find child sessions of a parent, or " +
        "orient before searching. Does not scan message content — use search_sessions for that.",
      args: {
        parent_session_id: tool.schema
          .string()
          .optional()
          .describe("Filter to child sessions of this parent session ID."),
        global: tool.schema
          .boolean()
          .optional()
          .describe("List sessions across all projects instead of just the current one (default: false)"),
        max_sessions: tool.schema
          .number()
          .optional()
          .describe("Max sessions to return (default: 50)"),
      },
      async execute(args) {
        const maxSessions = args.max_sessions ?? 50

        let sessions: SessionMeta[]

        if (args.global) {
          sessions = await fetchGlobalSessions(ctx.client, args.parent_session_id ? 500 : maxSessions)
        } else {
          sessions = await fetchLocalSessions(ctx.client)
        }

        if (args.parent_session_id) {
          sessions = sessions.filter((s) => s.parentID === args.parent_session_id)
        }

        sessions = sessions.slice(0, maxSessions)

        return {
          title: `Found ${sessions.length} session${sessions.length === 1 ? "" : "s"}`,
          output: formatSessionList(sessions),
          metadata: {
            count: sessions.length,
          },
        }
      },
    }),

    db_query: tool({
      description:
        "Run a single read-only SQL statement (SELECT, WITH, or EXPLAIN) directly against opencode's local SQLite session database. " +
        "Read-only is enforced at the engine level — writes are impossible. " +
        "Returns JSON rows, one per line, capped at max_rows rows and max_chars characters per value. " +
        "Discover the schema with: SELECT sql FROM sqlite_master WHERE type = 'table'. " +
        "Core tables: session, message, part (message and part have a `data` JSON column; timestamps are epoch milliseconds). " +
        "Fastest path for structured session-history questions: joins, counts, tool-call history, todos, cost rollups. " +
        "Never select part.data unbounded — tool outputs can be megabytes; use substr(json_extract(...), 1, N). " +
        "Use db_read_session to read a conversation, db_search for substring search.",
      args: {
        sql: tool.schema
          .string()
          .describe("Single SQL statement (SELECT/WITH/EXPLAIN only). Timestamps are epoch milliseconds."),
        max_rows: tool.schema.number().optional().describe("Max rows to return (default: 50, max: 500)"),
        max_chars: tool.schema
          .number()
          .optional()
          .describe("Max characters per cell value, truncated with a marker (default: 500, max: 4000)"),
      },
      async execute(args) {
        const result = db.query(args.sql, { maxRows: args.max_rows, maxChars: args.max_chars })
        const lines: string[] = [
          `${result.rowCount} row${result.rowCount === 1 ? "" : "s"} in ${result.elapsedMs} ms` +
            (result.truncatedRows ? " (row-capped)" : "") +
            (result.truncatedValues > 0 ? ` (${result.truncatedValues} values truncated)` : ""),
        ]
        for (const row of result.rows) lines.push(JSON.stringify(row))
        return {
          title: `${result.rowCount} row(s) in ${result.elapsedMs}ms`,
          output: lines.join("\n"),
          metadata: {
            rowCount: result.rowCount,
            truncatedRows: result.truncatedRows,
            truncatedValues: result.truncatedValues,
            elapsedMs: result.elapsedMs,
          },
        }
      },
    }),

    db_read_session: tool({
      description:
        "Read a session's conversation directly from the database: every part of every message in chronological order, " +
        "rendered as readable text with roles and part types. " +
        'Defaults to text + reasoning parts; include "tool" for tool calls with their outputs, "step-start" for step boundaries. ' +
        "Completes in milliseconds regardless of session size. Use to recall exactly what happened in a past session.",
      args: {
        session_id: tool.schema.string().describe("Session ID (ses_...)"),
        types: tool.schema
          .array(tool.schema.enum(["text", "reasoning", "tool", "step-start"]))
          .optional()
          .describe('Part types to include (default: ["text", "reasoning"])'),
        limit: tool.schema
          .number()
          .optional()
          .describe("Max parts to return in chronological order (default: 100, max: 500)"),
        chars_per_part: tool.schema
          .number()
          .optional()
          .describe("Max characters per part, truncated with a marker (default: 600, max: 8000)"),
      },
      async execute(args) {
        const result = db.readSession(args.session_id, {
          types: args.types,
          limit: args.limit,
          charsPerPart: args.chars_per_part,
        })
        return {
          title: `${result.parts.length} parts from "${result.session.title ?? result.session.id}" in ${result.elapsedMs}ms`,
          output: formatDbSessionRead(result),
          metadata: {
            sessionId: result.session.id,
            parts: result.parts.length,
            truncated: result.truncated,
            elapsedMs: result.elapsedMs,
          },
        }
      },
    }),

    db_search: tool({
      description:
        "Substring search over session content, tiered by scope. " +
        '"titles": session titles only — instant. ' +
        '"session": every part of one session — milliseconds (requires session_id). ' +
        '"global": every part of every session — full table scan, typically 10–30 seconds; narrow first (titles, project, session) when possible. ' +
        'Default scope: "session" when session_id is given, otherwise "global". ' +
        "Matches conversation text, reasoning, and tool inputs/outputs. Returns snippets with session titles and roles.",
      args: {
        query: tool.schema.string().describe("Search term (case-insensitive substring; % and _ match literally)"),
        session_id: tool.schema
          .string()
          .optional()
          .describe('Restrict search to this session (required and implied for scope "session")'),
        scope: tool.schema
          .enum(["titles", "session", "global"])
          .optional()
          .describe('Search scope: "titles" (instant), "session" (ms), "global" (full scan, 10-30s)'),
        limit: tool.schema.number().optional().describe("Max matches to return (default: 25, max: 200)"),
      },
      async execute(args) {
        const result = db.searchSessions(args.query, {
          sessionId: args.session_id,
          scope: args.scope,
          limit: args.limit,
        })
        return {
          title: `${result.matches.length} match(es) in ${result.scope} scope in ${result.elapsedMs}ms`,
          output: formatDbSearch(result),
          metadata: {
            scope: result.scope,
            matches: result.matches.length,
            truncated: result.truncated,
            elapsedMs: result.elapsedMs,
          },
        }
      },
    }),
  },
})

export default { id: "session-search", server: plugin } satisfies PluginModule
