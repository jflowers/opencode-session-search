import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { registerSkills, SKILLS_DIR } from "./skills"

describe("registerSkills", () => {
  test("adds the bundled skills dir to an empty config", () => {
    const config: Record<string, unknown> = {}
    registerSkills(config)
    expect(config).toEqual({ skills: { paths: [SKILLS_DIR] } })
  })

  test("keeps the user's paths and adds the dir once", () => {
    const config = { skills: { paths: ["/mine"] } }
    registerSkills(config)
    registerSkills(config)
    expect(config.skills.paths).toEqual(["/mine", SKILLS_DIR])
  })

  test("points at a dir holding SKILL.md files", () => {
    expect(existsSync(SKILLS_DIR)).toBe(true)
  })
})
