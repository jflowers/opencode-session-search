import { Database } from "bun:sqlite"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const MAX_ROWS = 500
const MAX_CHARS = 4000
const FIRST_KEYWORD = /^\s*(select|with|explain)\b/i
const WRITE_KEYWORDS = /\b(insert|update|delete|replace|create|drop|alter|attach|detach|vacuum|reindex|analyze|pragma)\b/i

export type SqlValue = string | number | null

export type QueryResult = {
  columns: string[]
  rows: Record<string, SqlValue>[]
  rowCount: number
  truncatedRows: boolean
  truncatedValues: number
  elapsedMs: number
}

export type PartType = "text" | "reasoning" | "tool" | "step-start"

export type DbSession = {
  id: string
  title: SqlValue
  directory: SqlValue
  parentId: SqlValue
  agent: SqlValue
  model: SqlValue
  cost: SqlValue
  tokensInput: SqlValue
  tokensOutput: SqlValue
  timeCreated: number
  timeUpdated: number
}

export type SessionPart = {
  messageId: string
  role: SqlValue
  type: SqlValue
  text: SqlValue
  tool: SqlValue
  status: SqlValue
  toolOutput: SqlValue
  timeCreated: number
}

export type ReadSessionResult = {
  session: DbSession
  parts: SessionPart[]
  truncated: boolean
  elapsedMs: number
}

export type SearchScope = "titles" | "session" | "global"

export type SearchMatch = {
  sessionId: string
  title: SqlValue
  directory: SqlValue
  agent: SqlValue
  timeCreated: number
  messageId: SqlValue
  role: SqlValue
  type: SqlValue
  snippet: SqlValue
}

export type SearchResult = {
  scope: SearchScope
  term: string
  /** The words that all had to match (a quoted phrase is one word). */
  words: string[]
  matches: SearchMatch[]
  truncated: boolean
  elapsedMs: number
}

export type DbPathSources = {
  env?: Record<string, string | undefined>
  /** Runs `opencode db path`; returns its trimmed stdout, or null when it fails. */
  opencodeDbPath?: () => string | null
}

function runOpencodeDbPath(): string | null {
  try {
    const result = spawnSync("opencode", ["db", "path"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    })
    if (result.status !== 0) return null
    return (result.stdout ?? "").trim() || null
  } catch {
    return null
  }
}

/**
 * Resolve the database path, in order:
 * 1. `OPENCODE_DB_PATH`
 * 2. `opencode db path` (opencode's own answer)
 * 3. `${XDG_DATA_HOME ?? ~/.local/share}/opencode/opencode.db`
 */
export function resolveDbPath(sources: DbPathSources = {}): string {
  const env = sources.env ?? process.env
  const fromEnv = env.OPENCODE_DB_PATH?.trim()
  if (fromEnv) return fromEnv
  const fromCli = (sources.opencodeDbPath ?? runOpencodeDbPath)()
  if (fromCli) return fromCli
  const dataHome = env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(dataHome, "opencode", "opencode.db")
}

let cachedPath: string | undefined

/** The resolved database path, looked up once per process. */
export function dbPath(): string {
  cachedPath ??= resolveDbPath()
  return cachedPath
}

export function openDB(): Database {
  const file = dbPath()
  if (!existsSync(file)) throw new Error(`opencode database not found at ${file}`)
  const db = new Database(file, { readonly: true })
  db.exec("PRAGMA busy_timeout = 5000")
  return db
}

function clamp(n: number | undefined, min: number, max: number, fallback: number): number {
  const value = Math.floor(n ?? fallback)
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function stripLiterals(sql: string): string {
  let out = ""
  let inString = false
  let inIdent = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (inLine) {
      if (ch === "\n") {
        inLine = false
        out += ch
      }
      continue
    }
    if (inBlock) {
      if (ch === "*" && sql[i + 1] === "/") {
        inBlock = false
        i++
      }
      continue
    }
    if (inString) {
      if (ch === "'" && sql[i + 1] === "'") {
        i++
        continue
      }
      if (ch === "'") inString = false
      continue
    }
    if (inIdent) {
      if (ch === '"') inIdent = false
      continue
    }
    if (ch === "'") {
      inString = true
      out += " "
      continue
    }
    if (ch === '"') {
      inIdent = true
      out += " "
      continue
    }
    if (ch === "-" && sql[i + 1] === "-") {
      inLine = true
      i++
      continue
    }
    if (ch === "/" && sql[i + 1] === "*") {
      inBlock = true
      i++
      continue
    }
    out += ch
  }
  return out
}

export function validateSql(sql: string): void {
  const stripped = stripLiterals(sql)
  if (!FIRST_KEYWORD.test(stripped)) {
    throw new Error("only a single SELECT, WITH, or EXPLAIN statement is allowed (the connection is read-only)")
  }
  const keyword = WRITE_KEYWORDS.exec(stripped)
  if (keyword) {
    throw new Error(`write keyword "${keyword[0].toLowerCase()}" is not allowed (the connection is read-only)`)
  }
  for (let i = 0; i < stripped.length; i++) {
    if (stripped[i] === ";" && stripped.slice(i + 1).trim() !== "") {
      throw new Error("only a single SQL statement is allowed")
    }
  }
}

function truncateCell(value: unknown, maxChars: number): { value: SqlValue; truncated: boolean } {
  if (value === null || value === undefined) return { value: null, truncated: false }
  if (typeof value === "number") return { value, truncated: false }
  if (typeof value === "bigint") {
    const asNumber = Number(value)
    return { value: Number.isSafeInteger(asNumber) ? asNumber : value.toString(), truncated: false }
  }
  if (value instanceof Uint8Array) return { value: `[blob: ${value.length} bytes]`, truncated: false }
  const str = String(value)
  if (str.length > maxChars) {
    return { value: `${str.slice(0, maxChars)}…[+${str.length - maxChars} chars]`, truncated: true }
  }
  return { value: str, truncated: false }
}

export function query(sql: string, opts: { maxRows?: number; maxChars?: number } = {}): QueryResult {
  validateSql(sql)
  const maxRows = clamp(opts.maxRows, 1, MAX_ROWS, 50)
  const maxChars = clamp(opts.maxChars, 1, MAX_CHARS, 500)
  const db = openDB()
  const started = performance.now()
  try {
    const stmt = db.prepare(sql)
    const columns = [...(stmt.columnNames as string[])]
    const rows: Record<string, SqlValue>[] = []
    let truncatedRows = false
    let truncatedValues = 0
    for (const raw of stmt.iterate() as Iterable<Record<string, unknown>>) {
      if (rows.length === maxRows) {
        truncatedRows = true
        break
      }
      const row: Record<string, SqlValue> = {}
      for (const key of columns) {
        const cell = truncateCell(raw[key], maxChars)
        if (cell.truncated) truncatedValues++
        row[key] = cell.value
      }
      rows.push(row)
    }
    return {
      columns,
      rows,
      rowCount: rows.length,
      truncatedRows,
      truncatedValues,
      elapsedMs: Math.round(performance.now() - started),
    }
  } finally {
    db.close()
  }
}

export function readSession(
  sessionId: string,
  opts: { types?: PartType[]; limit?: number; charsPerPart?: number } = {},
): ReadSessionResult {
  const types = opts.types && opts.types.length > 0 ? opts.types : (["text", "reasoning"] as PartType[])
  const limit = clamp(opts.limit, 1, 500, 100)
  const chars = clamp(opts.charsPerPart, 1, 8000, 600)
  const db = openDB()
  const started = performance.now()
  try {
    const session = db
      .prepare(
        "SELECT id, title, directory, parent_id, agent, model, cost, tokens_input, tokens_output, time_created, time_updated FROM session WHERE id = ?",
      )
      .get(sessionId) as any
    if (!session) throw new Error(`session not found: ${sessionId}`)
    const placeholders = types.map(() => "?").join(", ")
    const rows = db
      .prepare(
        `SELECT m.id AS message_id, ` +
          `json_extract(m.data, '$.role') AS role, ` +
          `json_extract(p.data, '$.type') AS type, ` +
          `substr(json_extract(p.data, '$.text'), 1, ?) AS text, ` +
          `json_extract(p.data, '$.tool') AS tool, ` +
          `json_extract(p.data, '$.state.status') AS status, ` +
          `substr(json_extract(p.data, '$.state.output'), 1, ?) AS tool_output, ` +
          `p.time_created AS part_time ` +
          `FROM message m JOIN part p ON p.message_id = m.id ` +
          `WHERE m.session_id = ? AND json_extract(p.data, '$.type') IN (${placeholders}) ` +
          `ORDER BY m.time_created, m.id, p.time_created, p.id LIMIT ?`,
      )
      .all(chars, chars, sessionId, ...types, limit + 1) as any[]
    const truncated = rows.length > limit
    if (truncated) rows.pop()
    const parts: SessionPart[] = rows.map((r) => ({
      messageId: r.message_id,
      role: r.role ?? null,
      type: r.type ?? null,
      text: r.text ?? null,
      tool: r.tool ?? null,
      status: r.status ?? null,
      toolOutput: r.tool_output ?? null,
      timeCreated: r.part_time,
    }))
    const meta: DbSession = {
      id: session.id,
      title: session.title ?? null,
      directory: session.directory ?? null,
      parentId: session.parent_id ?? null,
      agent: session.agent ?? null,
      model: session.model ?? null,
      cost: session.cost ?? null,
      tokensInput: session.tokens_input ?? null,
      tokensOutput: session.tokens_output ?? null,
      timeCreated: session.time_created,
      timeUpdated: session.time_updated,
    }
    return { session: meta, parts, truncated, elapsedMs: Math.round(performance.now() - started) }
  } finally {
    db.close()
  }
}

/**
 * Split a search query into the words that must all match.
 * Whitespace separates words; a double-quoted phrase stays one word.
 * Lowercased and de-duplicated.
 */
export function splitSearchTerms(query: string): string[] {
  const words: string[] = []
  for (const m of query.matchAll(/"([^"]*)"|(\S+)/g)) {
    const word = (m[1] ?? m[2] ?? "").trim().toLowerCase()
    if (word && !words.includes(word)) words.push(word)
  }
  return words
}

function likePattern(word: string): string {
  return `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

export function searchSessions(
  term: string,
  opts: { sessionId?: string; scope?: SearchScope; limit?: number } = {},
): SearchResult {
  const needle = term.trim()
  const words = splitSearchTerms(needle)
  if (words.length === 0) throw new Error("query must be a non-empty search term")
  const scope: SearchScope = opts.scope ?? (opts.sessionId ? "session" : "global")
  if (scope === "session" && !opts.sessionId) {
    throw new Error('scope "session" requires a session_id')
  }
  const limit = clamp(opts.limit, 1, 200, 25)
  const patterns = words.map(likePattern)
  const allLike = (column: string) => words.map(() => `${column} LIKE ? ESCAPE '\\'`).join(" AND ")
  const db = openDB()
  const started = performance.now()
  try {
    if (scope === "titles") {
      const rows = db
        .prepare(
          `SELECT id, title, directory, agent, time_created FROM session WHERE ${allLike("title")} ORDER BY time_updated DESC LIMIT ?`,
        )
        .all(...patterns, limit + 1) as any[]
      const truncated = rows.length > limit
      if (truncated) rows.pop()
      const matches: SearchMatch[] = rows.map((r) => ({
        sessionId: r.id,
        title: r.title ?? null,
        directory: r.directory ?? null,
        agent: r.agent ?? null,
        timeCreated: r.time_created,
        messageId: null,
        role: null,
        type: null,
        snippet: null,
      }))
      return { scope, term: needle, words, matches, truncated, elapsedMs: Math.round(performance.now() - started) }
    }
    const order = scope === "session" ? "ASC" : "DESC"
    const sessionFilter = scope === "session" ? "AND p.session_id = ? " : ""
    const sql =
      `SELECT p.session_id, s.title, s.directory, p.message_id, ` +
      `json_extract(m.data, '$.role') AS role, ` +
      `json_extract(p.data, '$.type') AS type, ` +
      `substr(p.data, max(1, instr(lower(p.data), lower(?)) - 150), 400) AS snippet, ` +
      `p.time_created ` +
      `FROM part p ` +
      `JOIN message m ON m.id = p.message_id ` +
      `JOIN session s ON s.id = p.session_id ` +
      `WHERE ${allLike("p.data")} ${sessionFilter}` +
      `ORDER BY p.time_created ${order} LIMIT ?`
    // The snippet is centred on the first word.
    const params: unknown[] =
      scope === "session"
        ? [words[0], ...patterns, opts.sessionId, limit + 1]
        : [words[0], ...patterns, limit + 1]
    const rows = db.prepare(sql).all(...(params as any[])) as any[]
    const truncated = rows.length > limit
    if (truncated) rows.pop()
    const matches: SearchMatch[] = rows.map((r) => ({
      sessionId: r.session_id,
      title: r.title ?? null,
      directory: r.directory ?? null,
      agent: null,
      timeCreated: r.time_created,
      messageId: r.message_id ?? null,
      role: r.role ?? null,
      type: r.type ?? null,
      snippet: r.snippet ?? null,
    }))
    return { scope, term: needle, words, matches, truncated, elapsedMs: Math.round(performance.now() - started) }
  } finally {
    db.close()
  }
}
