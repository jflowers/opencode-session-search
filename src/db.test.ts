import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { Database } from "bun:sqlite"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  dbPath,
  openDB,
  query,
  readSession,
  resolveDbPath,
  searchSessions,
  splitSearchTerms,
  validateSql,
} from "./db"

const dbExists = existsSync(dbPath())

describe("validateSql", () => {
  test("rejects non-SELECT first keywords", () => {
    expect(() => validateSql("PRAGMA user_version")).toThrow()
    expect(() => validateSql("VACUUM")).toThrow()
    expect(() => validateSql("DELETE FROM session")).toThrow()
  })

  test("rejects multiple statements", () => {
    expect(() => validateSql("SELECT 1; SELECT 2")).toThrow()
    expect(() => validateSql("SELECT * FROM session; DROP TABLE part")).toThrow()
  })

  test("rejects write keywords outside literals", () => {
    expect(() => validateSql("WITH x AS (SELECT 1) DELETE FROM session")).toThrow()
    expect(() => validateSql("SELECT * FROM session WHERE title LIKE '%x%'; INSERT INTO session VALUES (1)")).toThrow()
  })

  test("allows write keywords inside string literals and comments", () => {
    expect(() => validateSql("SELECT 'drop it' AS s")).not.toThrow()
    expect(() => validateSql("SELECT 'he said ''vacuum''' AS s")).not.toThrow()
    expect(() => validateSql("SELECT time_updated FROM session -- recent updates")).not.toThrow()
  })

  test("allows trailing semicolon", () => {
    expect(() => validateSql("SELECT 1;")).not.toThrow()
  })
})

describe("database", () => {
  test.skipIf(!dbExists)("opens read-only against the live WAL database", () => {
    const db = openDB()
    try {
      const row = db.prepare("SELECT count(*) AS n FROM session").get() as any
      expect(row.n).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })

  test.skipIf(!dbExists)("engine rejects writes with SQLITE_READONLY", () => {
    const db = openDB()
    try {
      expect(() => db.run("UPDATE session SET title = title WHERE id = 'nonexistent'")).toThrow(/READONLY/i)
      expect(() => db.exec("PRAGMA wal_checkpoint")).toThrow()
    } finally {
      db.close()
    }
  })
})

describe("query", () => {
  test.skipIf(!dbExists)("returns capped rows as JSON-safe objects", () => {
    const result = query("SELECT id FROM session", { maxRows: 5 })
    expect(result.rowCount).toBe(5)
    expect(result.truncatedRows).toBe(true)
    expect(result.rows[0].id).toMatch(/^ses_/)
    expect(typeof result.elapsedMs).toBe("number")
  })

  test.skipIf(!dbExists)("truncates long values with a marker", () => {
    const result = query(
      "SELECT substr(json_extract(p.data, '$.text'), 1, 3000) AS t FROM part p " +
        "WHERE json_extract(p.data, '$.type') = 'text' AND length(json_extract(p.data, '$.text')) > 2500 LIMIT 1",
      { maxChars: 50 },
    )
    expect(result.rows.length).toBe(1)
    expect(result.rows[0].t).toContain("+")
    expect(result.truncatedValues).toBe(1)
  })

  test.skipIf(!dbExists)("rejects invalid SQL before touching the database", () => {
    expect(() => query("DELETE FROM session")).toThrow()
    expect(() => query("SELECT 1; SELECT 2")).toThrow()
  })
})

describe("readSession", () => {
  test.skipIf(!dbExists)("returns session meta and ordered parts", () => {
    const found = query(
      "SELECT p.session_id AS id FROM part p WHERE json_extract(p.data, '$.type') = 'text' LIMIT 1",
    )
    const sessionId = found.rows[0].id as string
    const result = readSession(sessionId, { limit: 10, charsPerPart: 200 })
    expect(result.session.id).toBe(sessionId)
    expect(result.session.timeCreated).toBeGreaterThan(0)
    expect(Array.isArray(result.parts)).toBe(true)
    for (const part of result.parts) {
      expect(part.messageId).toMatch(/^msg_/)
    }
    const times = result.parts.map((p) => p.timeCreated)
    expect([...times].sort((a, b) => a - b)).toEqual(times)
  })

  test.skipIf(!dbExists)("throws for unknown session", () => {
    expect(() => readSession("ses_does_not_exist")).toThrow(/not found/)
  })
})

describe("searchSessions", () => {
  test.skipIf(!dbExists)("titles scope finds sessions instantly", () => {
    const result = searchSessions("session", { scope: "titles", limit: 5 })
    expect(result.scope).toBe("titles")
    expect(result.matches.length).toBeGreaterThan(0)
    expect(result.matches[0].sessionId).toMatch(/^ses_/)
    expect(result.elapsedMs).toBeLessThan(2000)
  })

  test.skipIf(!dbExists)("session scope searches within one session", () => {
    const found = query(
      "SELECT p.session_id AS id FROM part p WHERE json_extract(p.data, '$.type') = 'text' LIMIT 1",
    )
    const sessionId = found.rows[0].id as string
    const result = searchSessions("e", { scope: "session", sessionId, limit: 5 })
    expect(result.scope).toBe("session")
    expect(result.elapsedMs).toBeLessThan(5000)
    for (const m of result.matches) {
      expect(m.sessionId).toBe(sessionId)
    }
  })

  test("session scope requires a session_id", () => {
    expect(() => searchSessions("x", { scope: "session" })).toThrow(/session_id/)
  })

  test("rejects empty search terms", () => {
    expect(() => searchSessions("   ")).toThrow(/non-empty/)
  })
})

describe("resolveDbPath", () => {
  const failingCli = () => null

  test("OPENCODE_DB_PATH wins over everything", () => {
    const path = resolveDbPath({
      env: { OPENCODE_DB_PATH: "/env/opencode.db", XDG_DATA_HOME: "/xdg" },
      opencodeDbPath: () => "/cli/opencode.db",
    })
    expect(path).toBe("/env/opencode.db")
  })

  test("uses `opencode db path` when the env var is unset", () => {
    const path = resolveDbPath({ env: { XDG_DATA_HOME: "/xdg" }, opencodeDbPath: () => "/cli/opencode.db" })
    expect(path).toBe("/cli/opencode.db")
  })

  test("falls back to XDG_DATA_HOME when the CLI fails", () => {
    expect(resolveDbPath({ env: { XDG_DATA_HOME: "/xdg" }, opencodeDbPath: failingCli })).toBe(
      "/xdg/opencode/opencode.db",
    )
  })

  test("falls back to ~/.local/share when nothing else is set", () => {
    expect(resolveDbPath({ env: {}, opencodeDbPath: failingCli })).toBe(
      join(homedir(), ".local", "share", "opencode", "opencode.db"),
    )
  })

  test("ignores a blank OPENCODE_DB_PATH", () => {
    expect(resolveDbPath({ env: { OPENCODE_DB_PATH: "  " }, opencodeDbPath: () => "/cli/opencode.db" })).toBe(
      "/cli/opencode.db",
    )
  })
})

describe("splitSearchTerms", () => {
  test("splits on whitespace and lowercases", () => {
    expect(splitSearchTerms("  Auth   LOGIN\tflow ")).toEqual(["auth", "login", "flow"])
  })

  test("keeps a double-quoted phrase as one word", () => {
    expect(splitSearchTerms('"Connection refused" retry')).toEqual(["connection refused", "retry"])
  })

  test("drops duplicates and empty quotes", () => {
    expect(splitSearchTerms('auth AUTH "" auth')).toEqual(["auth"])
  })

  test("returns nothing for blank input", () => {
    expect(splitSearchTerms('   ""  ')).toEqual([])
  })
})

describe("searchSessions all-words matching", () => {
  test.skipIf(!dbExists)("every title match contains every word, in any order", () => {
    const found = query(
      "SELECT title FROM session WHERE title LIKE '% %' AND length(title) > 10 ORDER BY time_updated DESC LIMIT 1",
    )
    if (found.rows.length === 0) return
    const titleWords = String(found.rows[0].title).toLowerCase().split(/\s+/).filter(Boolean)
    const reversed = [titleWords[titleWords.length - 1], titleWords[0]].join(" ")
    const result = searchSessions(reversed, { scope: "titles", limit: 50 })
    expect(result.words).toEqual(splitSearchTerms(reversed))
    expect(result.matches.length).toBeGreaterThan(0)
    for (const m of result.matches) {
      const title = String(m.title).toLowerCase()
      for (const w of result.words) expect(title).toContain(w)
    }
  })

  test.skipIf(!dbExists)("session scope requires every word in the same part", () => {
    const found = query(
      "SELECT p.session_id AS id FROM part p WHERE json_extract(p.data, '$.type') = 'text' LIMIT 1",
    )
    const sessionId = found.rows[0].id as string
    const result = searchSessions("e a", { scope: "session", sessionId, limit: 20 })
    expect(result.words).toEqual(["e", "a"])
    const impossible = searchSessions("e zzqqxx-no-such-word-9f3", { scope: "session", sessionId, limit: 20 })
    expect(impossible.matches).toEqual([])
  })

  test("rejects a query of only empty quotes", () => {
    expect(() => searchSessions('""')).toThrow(/non-empty/)
  })
})

describe("searchSessions grouping and filters", () => {
  const sessionWithText = () =>
    // A recent session with more than 3 text parts. Only the 50 newest sessions are checked, and each
    // check stops after 4 parts on the part(session_id) index, so this takes milliseconds.
    query(
      "SELECT s.id FROM (SELECT id, time_updated FROM session ORDER BY time_updated DESC LIMIT 50) s " +
        "WHERE (SELECT count(*) FROM (SELECT 1 FROM part p WHERE p.session_id = s.id " +
        "AND json_extract(p.data, '$.type') = 'text' LIMIT 4)) > 3 ORDER BY s.time_updated DESC LIMIT 1",
    ).rows[0]?.id as string | undefined

  test.skipIf(!dbExists)("group_by_session returns one entry per session with counts and capped snippets", () => {
    const sessionId = sessionWithText()
    if (!sessionId) return
    const result = searchSessions("e", { scope: "session", sessionId, groupBySession: true, snippetsPerSession: 2 })
    expect(result.sessions).not.toBeNull()
    expect(result.sessions!.length).toBe(1)
    const hit = result.sessions![0]
    expect(hit.sessionId).toBe(sessionId)
    expect(hit.matchCount).toBeGreaterThan(0)
    expect(hit.snippets.length).toBeLessThanOrEqual(2)
    expect(hit.snippets.length).toBeLessThanOrEqual(hit.matchCount)
    for (const m of hit.snippets) expect(m.timeCreated).toBeLessThanOrEqual(hit.lastMatch)
    // Snippets are the latest matches, newest first.
    const times = hit.snippets.map((m) => m.timeCreated)
    expect([...times].sort((a, b) => b - a)).toEqual(times)
  })

  test.skipIf(!dbExists)("ungrouped searches report sessions as null", () => {
    const sessionId = sessionWithText()
    if (!sessionId) return
    expect(searchSessions("e", { scope: "session", sessionId }).sessions).toBeNull()
  })

  test.skipIf(!dbExists)("types limits matches to those part types", () => {
    const sessionId = sessionWithText()
    if (!sessionId) return
    const result = searchSessions("e", { scope: "session", sessionId, types: ["text"], limit: 50 })
    expect(result.matches.length).toBeGreaterThan(0)
    for (const m of result.matches) expect(m.type).toBe("text")
  })

  test.skipIf(!dbExists)("since_days drops older matches", () => {
    const sessionId = sessionWithText()
    if (!sessionId) return
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
    const result = searchSessions("e", { scope: "session", sessionId, sinceDays: 30, limit: 200 })
    for (const m of result.matches) expect(m.timeCreated).toBeGreaterThanOrEqual(cutoff)
    const titles = searchSessions("e", { scope: "titles", sinceDays: 1, limit: 200 })
    const recent = query(
      `SELECT count(*) AS n FROM session WHERE title LIKE '%e%' AND time_updated >= ${Date.now() - 24 * 60 * 60 * 1000}`,
    ).rows[0].n as number
    expect(titles.matches.length).toBe(Math.min(recent, 200))
  })
})

describe("readSession order, project details and empty parts", () => {
  const busySession = () =>
    // A recent session with more than 5 text parts. Only the 50 newest sessions are checked, and each
    // check stops after 6 parts on the part(session_id) index, so this takes milliseconds.
    query(
      "SELECT s.id FROM (SELECT id, time_updated FROM session ORDER BY time_updated DESC LIMIT 50) s " +
        "WHERE (SELECT count(*) FROM (SELECT 1 FROM part p WHERE p.session_id = s.id " +
        "AND json_extract(p.data, '$.type') = 'text' LIMIT 6)) > 5 ORDER BY s.time_updated DESC LIMIT 1",
    ).rows[0]?.id as string | undefined

  test.skipIf(!dbExists)('order "desc" returns the newest parts first', () => {
    const id = busySession()
    if (!id) return
    const asc = readSession(id, { types: ["text"], limit: 500 })
    const desc = readSession(id, { types: ["text"], limit: 3, order: "desc" })
    expect(desc.order).toBe("desc")
    expect(desc.parts.length).toBe(Math.min(3, asc.parts.length))
    const times = desc.parts.map((p) => p.timeCreated)
    expect([...times].sort((a, b) => b - a)).toEqual(times)
    expect(desc.parts[0].timeCreated).toBe(asc.parts[asc.parts.length - 1].timeCreated)
  })

  test.skipIf(!dbExists)("includes slug and project details", () => {
    const id = busySession()
    if (!id) return
    const expected = query(
      `SELECT s.slug, pr.name, pr.worktree FROM session s LEFT JOIN project pr ON pr.id = s.project_id WHERE s.id = '${id}'`,
    ).rows[0]
    const { session } = readSession(id, { limit: 1 })
    expect(session.slug).toBe(expected.slug)
    expect(session.projectName).toBe(expected.name)
    expect(session.projectWorktree).toBe(expected.worktree)
  })

  test.skipIf(!dbExists)("skips text and reasoning parts with no text", () => {
    const id = busySession()
    if (!id) return
    const { parts } = readSession(id, { types: ["text", "reasoning"], limit: 500 })
    for (const p of parts) expect(String(p.text ?? "").trim().length).toBeGreaterThan(0)
  })
})
