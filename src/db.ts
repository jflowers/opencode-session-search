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
  slug: SqlValue
  projectName: SqlValue
  projectWorktree: SqlValue
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
  order: "asc" | "desc"
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
  /** Individual matches; when grouping, every session's snippets in session order. */
  matches: SearchMatch[]
  /** One entry per session when the search was grouped; otherwise null. */
  sessions: SessionHit[] | null
  /** More matches (or sessions, when grouping) existed than the limit. */
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
  opts: {
    types?: PartType[]
    limit?: number
    charsPerPart?: number
    /** "asc" (default): oldest first. "desc": newest first, so `limit` keeps the latest parts. */
    order?: "asc" | "desc"
  } = {},
): ReadSessionResult {
  const types = opts.types && opts.types.length > 0 ? opts.types : (["text", "reasoning"] as PartType[])
  const limit = clamp(opts.limit, 1, 500, 100)
  const chars = clamp(opts.charsPerPart, 1, 8000, 600)
  const dir = opts.order === "desc" ? "DESC" : "ASC"
  const db = openDB()
  const started = performance.now()
  try {
    const session = db
      .prepare(
        "SELECT s.id, s.title, s.directory, s.parent_id, s.agent, s.model, s.cost, s.tokens_input, s.tokens_output, " +
          "s.time_created, s.time_updated, s.slug, pr.name AS project_name, pr.worktree AS project_worktree " +
          "FROM session s LEFT JOIN project pr ON pr.id = s.project_id WHERE s.id = ?",
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
          // Skip text and reasoning parts with nothing in them.
          `AND NOT (json_extract(p.data, '$.type') IN ('text', 'reasoning') ` +
          `AND length(trim(coalesce(json_extract(p.data, '$.text'), ''))) = 0) ` +
          `ORDER BY m.time_created ${dir}, m.id ${dir}, p.time_created ${dir}, p.id ${dir} LIMIT ?`,
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
      slug: session.slug ?? null,
      projectName: session.project_name ?? null,
      projectWorktree: session.project_worktree ?? null,
    }
    return {
      session: meta,
      parts,
      order: dir === "DESC" ? "desc" : "asc",
      truncated,
      elapsedMs: Math.round(performance.now() - started),
    }
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

/** One session in a grouped search: its match count and its latest matching snippets. */
export type SessionHit = {
  sessionId: string
  title: SqlValue
  directory: SqlValue
  matchCount: number
  lastMatch: number
  snippets: SearchMatch[]
}

export type SearchOptions = {
  sessionId?: string
  scope?: SearchScope
  /** Max matches, or max sessions when grouping. */
  limit?: number
  /** Only parts of these types (content scopes). Default: all types. */
  types?: PartType[]
  /** Only parts (or, for titles, sessions updated) in the last N days. */
  sinceDays?: number
  /** Return one entry per session, ranked by match count, instead of individual matches. */
  groupBySession?: boolean
  /** Snippets per session when grouping (default 2, max 10). */
  snippetsPerSession?: number
}

const DAY_MS = 24 * 60 * 60 * 1000

export function searchSessions(term: string, opts: SearchOptions = {}): SearchResult {
  const needle = term.trim()
  const words = splitSearchTerms(needle)
  if (words.length === 0) throw new Error("query must be a non-empty search term")
  const scope: SearchScope = opts.scope ?? (opts.sessionId ? "session" : "global")
  if (scope === "session" && !opts.sessionId) {
    throw new Error('scope "session" requires a session_id')
  }
  const limit = clamp(opts.limit, 1, 200, 25)
  const since = opts.sinceDays !== undefined && opts.sinceDays > 0 ? Date.now() - opts.sinceDays * DAY_MS : null
  const patterns = words.map(likePattern)
  const allLike = (column: string) => words.map(() => `${column} LIKE ? ESCAPE '\\'`).join(" AND ")
  const elapsed = (started: number) => Math.round(performance.now() - started)
  const db = openDB()
  const started = performance.now()
  try {
    if (scope === "titles") {
      const sinceSql = since === null ? "" : "AND time_updated >= ? "
      const rows = db
        .prepare(
          `SELECT id, title, directory, agent, time_created FROM session WHERE ${allLike("title")} ${sinceSql}` +
            `ORDER BY time_updated DESC LIMIT ?`,
        )
        .all(...patterns, ...(since === null ? [] : [since]), limit + 1) as any[]
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
      return { scope, term: needle, words, matches, sessions: null, truncated, elapsedMs: elapsed(started) }
    }

    // Shared WHERE clause for the content scopes.
    const where: string[] = [allLike("p.data")]
    const whereParams: unknown[] = [...patterns]
    if (scope === "session") {
      where.push("p.session_id = ?")
      whereParams.push(opts.sessionId)
    }
    if (opts.types && opts.types.length > 0) {
      where.push(`json_extract(p.data, '$.type') IN (${opts.types.map(() => "?").join(", ")})`)
      whereParams.push(...opts.types)
    }
    if (since !== null) {
      where.push("p.time_created >= ?")
      whereParams.push(since)
    }
    const whereSql = where.join(" AND ")

    // The snippet is centred on the first word.
    const matchSql = (order: "ASC" | "DESC", extra = "") =>
      `SELECT p.session_id, s.title, s.directory, p.message_id, ` +
      `json_extract(m.data, '$.role') AS role, ` +
      `json_extract(p.data, '$.type') AS type, ` +
      `substr(p.data, max(1, instr(lower(p.data), lower(?)) - 150), 400) AS snippet, ` +
      `p.time_created ` +
      `FROM part p ` +
      `JOIN message m ON m.id = p.message_id ` +
      `JOIN session s ON s.id = p.session_id ` +
      `WHERE ${whereSql}${extra} ` +
      `ORDER BY p.time_created ${order} LIMIT ?`
    const toMatch = (r: any): SearchMatch => ({
      sessionId: r.session_id,
      title: r.title ?? null,
      directory: r.directory ?? null,
      agent: null,
      timeCreated: r.time_created,
      messageId: r.message_id ?? null,
      role: r.role ?? null,
      type: r.type ?? null,
      snippet: r.snippet ?? null,
    })

    if (opts.groupBySession) {
      const perSession = clamp(opts.snippetsPerSession, 1, 10, 2)
      const groups = db
        .prepare(
          `SELECT p.session_id, s.title, s.directory, COUNT(*) AS match_count, MAX(p.time_created) AS last_match ` +
            `FROM part p JOIN session s ON s.id = p.session_id ` +
            `WHERE ${whereSql} ` +
            `GROUP BY p.session_id ORDER BY match_count DESC, last_match DESC LIMIT ?`,
        )
        .all(...(whereParams as any[]), limit + 1) as any[]
      const truncated = groups.length > limit
      if (truncated) groups.pop()
      // Latest snippets per session: indexed by part(session_id), so milliseconds each.
      const snippetStmt = db.prepare(matchSql("DESC", " AND p.session_id = ?"))
      const sessions: SessionHit[] = groups.map((g) => ({
        sessionId: g.session_id,
        title: g.title ?? null,
        directory: g.directory ?? null,
        matchCount: Number(g.match_count),
        lastMatch: Number(g.last_match),
        snippets: (snippetStmt.all(words[0], ...(whereParams as any[]), g.session_id, perSession) as any[]).map(
          toMatch,
        ),
      }))
      const matches = sessions.flatMap((h) => h.snippets)
      return { scope, term: needle, words, matches, sessions, truncated, elapsedMs: elapsed(started) }
    }

    const order = scope === "session" ? "ASC" : "DESC"
    const rows = db.prepare(matchSql(order)).all(words[0], ...(whereParams as any[]), limit + 1) as any[]
    const truncated = rows.length > limit
    if (truncated) rows.pop()
    const matches = rows.map(toMatch)
    return { scope, term: needle, words, matches, sessions: null, truncated, elapsedMs: elapsed(started) }
  } finally {
    db.close()
  }
}
