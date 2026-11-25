import { describe, expect, test } from "bun:test"
import { formatNextSteps, MAX_QUESTION_OPTIONS, MAX_READ_SUGGESTIONS, rankSessions } from "./next-steps"

function suggestedQuestion(lines: string[]) {
  const text = lines.join("\n")
  const json = text.slice(text.indexOf("```json") + 7, text.lastIndexOf("```"))
  return JSON.parse(json).questions[0]
}

describe("rankSessions", () => {
  test("merges rows per session and ranks by match count", () => {
    const ranked = rankSessions([
      { sessionId: "ses_a", title: "A" },
      { sessionId: "ses_b", title: "B" },
      { sessionId: "ses_b", title: "B" },
      { sessionId: "ses_c", title: null },
      { sessionId: "ses_a", title: "A" },
      { sessionId: "ses_b", title: "B" },
    ])
    expect(ranked).toEqual([
      { id: "ses_b", title: "B", matches: 3 },
      { id: "ses_a", title: "A", matches: 2 },
      { id: "ses_c", title: null, matches: 1 },
    ])
  })

  test("ties keep the search's order", () => {
    const ranked = rankSessions([
      { sessionId: "ses_new", title: "new" },
      { sessionId: "ses_old", title: "old" },
    ])
    expect(ranked.map((s) => s.id)).toEqual(["ses_new", "ses_old"])
  })
})

describe("formatNextSteps", () => {
  test("nothing for no sessions", () => {
    expect(formatNextSteps([])).toEqual([])
  })

  test("one session: just the read call, no question", () => {
    const text = formatNextSteps([{ id: "ses_only", title: "Only", matches: 2 }]).join("\n")
    expect(text).toContain('db_read_session(session_id="ses_only")')
    expect(text).not.toContain("question")
  })

  test("several sessions: capped read calls and a question with the first recommended", () => {
    const sessions = Array.from({ length: 10 }, (_, i) => ({ id: `ses_${i}`, title: `Session ${i}`, matches: 10 - i }))
    const lines = formatNextSteps(sessions)
    const reads = lines.filter((l) => l.startsWith("- db_read_session("))
    expect(reads).toHaveLength(MAX_READ_SUGGESTIONS)
    expect(reads[0]).toContain('"ses_0"')

    const q = suggestedQuestion(lines)
    expect(q.multiple).toBe(false)
    expect(q.options).toHaveLength(MAX_QUESTION_OPTIONS)
    expect(q.options[0].label).toBe("Session 0 (Recommended)")
    expect(q.options[0].description).toBe("ses_0 — 10 matches")
    expect(q.options[1].label).toBe("Session 1")
  })

  test("title-only results omit match counts; long and missing titles are handled", () => {
    const lines = formatNextSteps([
      { id: "ses_long", title: "x".repeat(80), matches: null },
      { id: "ses_none", title: "  ", matches: null },
    ])
    const q = suggestedQuestion(lines)
    expect(q.options[0].label.length).toBeLessThanOrEqual(40 + " (Recommended)".length)
    expect(q.options[0].label).toContain("…")
    expect(q.options[0].description).toBe("ses_long")
    expect(q.options[1].label).toBe("Untitled")
    expect(lines.join("\n")).not.toMatch(/\d+ match/)
  })
})
