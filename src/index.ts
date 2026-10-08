import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"

type Depth = "conversation" | "tool" | "both"

const SNIPPET_RADIUS = 80

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

type Match = {
  role: string
  snippet: string
  timestamp: number
}

type SessionResult = {
  sessionID: string
  title: string
  date: string
  matches: Match[]
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

async function fetchGlobalSessions(
  serverUrl: URL,
  maxSessions: number,
): Promise<Array<{ id: string; title: string; created: number }>> {
  const sessions: Array<{ id: string; title: string; created: number }> = []
  let cursor: string | undefined

  while (sessions.length < maxSessions) {
    const url = new URL("/experimental/session", serverUrl)
    url.searchParams.set("roots", "true")
    url.searchParams.set("limit", String(Math.min(maxSessions - sessions.length, 50)))
    if (cursor) url.searchParams.set("cursor", cursor)

    const res = await fetch(url.toString())
    if (!res.ok) break

    const body = await res.json() as any
    const data = body.data ?? body
    if (!Array.isArray(data)) break

    for (const s of data) {
      sessions.push({
        id: s.id,
        title: s.title ?? "Untitled",
        created: s.time?.created ?? 0,
      })
    }

    if (!body.cursor?.next) break
    cursor = String(body.cursor.next)
  }

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

const plugin: Plugin = async (ctx) => ({
  tool: {
    search_sessions: tool({
      description:
        "Search past session history by message content. " +
        "Scans session messages for a text query and returns matching snippets. " +
        "Use to recall previous conversations, find when a topic was discussed, " +
        "or locate past solutions.",
      args: {
        query: tool.schema.string().describe("Search term (case-insensitive substring match)"),
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

        let sessions: Array<{ id: string; title: string; created: number }>

        if (args.global) {
          sessions = await fetchGlobalSessions(ctx.serverUrl, maxSessions)
        } else {
          const result = await ctx.client.session.list()
          const allSessions = (result.data ?? []).map((s: any) => ({
            id: s.id,
            title: s.title ?? "Untitled",
            created: s.time?.created ?? 0,
          }))
          allSessions.sort((a, b) => b.created - a.created)
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
  },
})

export default { server: plugin } satisfies PluginModule
