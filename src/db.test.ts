import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { Database } from "bun:sqlite"
import { dbPath, openDB, query, readSession, searchSessions, validateSql } from "./db"

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
