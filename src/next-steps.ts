/** A session that a search turned up, in the search's own order. */
export type FoundSession = {
  id: string
  title: string | null
  /** Matches inside this session; null when only the session itself matched (a title search). */
  matches: number | null
}

/** How many db_read_session calls to suggest. */
export const MAX_READ_SUGGESTIONS = 3
/** How many sessions to offer in the suggested question. */
export const MAX_QUESTION_OPTIONS = 8

/**
 * Merge per-match rows into one entry per session, ranked by match count
 * (ties keep the search's order).
 */
export function rankSessions(rows: { sessionId: string; title: string | null }[]): FoundSession[] {
  const byId = new Map<string, { id: string; title: string | null; matches: number; first: number }>()
  rows.forEach((row, i) => {
    const seen = byId.get(row.sessionId)
    if (seen) seen.matches++
    else byId.set(row.sessionId, { id: row.sessionId, title: row.title, matches: 1, first: i })
  })
  return [...byId.values()]
    .sort((a, b) => b.matches - a.matches || a.first - b.first)
    .map(({ id, title, matches }) => ({ id, title, matches }))
}

/**
 * The "Next step" section appended to search output: which db_read_session
 * calls to make, and, when several sessions match, a question the agent can
 * put to the user before reading one.
 */
export function formatNextSteps(sessions: FoundSession[]): string[] {
  if (sessions.length === 0) return []
  const lines = ["## Next step"]
  if (sessions.length === 1) {
    lines.push(`Read the session for full context: db_read_session(session_id="${sessions[0].id}")`)
    return lines
  }

  lines.push("Read a session for full context:")
  for (const s of sessions.slice(0, MAX_READ_SUGGESTIONS)) {
    lines.push(`- db_read_session(session_id="${s.id}")  ${describe(s)}`)
  }
  lines.push(
    "",
    `${sessions.length} sessions match. If it isn't clear which one the user means, ask with the question tool ` +
      "before reading. Suggested question:",
    "",
    "```json",
    JSON.stringify(
      {
        questions: [
          {
            header: "Pick session",
            question: "Which session should I open?",
            options: sessions.slice(0, MAX_QUESTION_OPTIONS).map((s, i) => ({
              label: i === 0 ? `${shortTitle(s)} (Recommended)` : shortTitle(s),
              description: s.matches === null ? s.id : `${s.id} — ${countLabel(s.matches)}`,
            })),
            multiple: false,
          },
        ],
      },
    ),
    "```",
  )
  return lines
}

const MAX_LABEL_CHARS = 40

function titleOf(s: FoundSession): string {
  return s.title?.trim() || "Untitled"
}

function shortTitle(s: FoundSession): string {
  const title = titleOf(s)
  return title.length > MAX_LABEL_CHARS ? `${title.slice(0, MAX_LABEL_CHARS - 1)}…` : title
}

function countLabel(n: number): string {
  return `${n} match${n === 1 ? "" : "es"}`
}

function describe(s: FoundSession): string {
  return s.matches === null ? titleOf(s) : `${titleOf(s)} — ${countLabel(s.matches)}`
}
