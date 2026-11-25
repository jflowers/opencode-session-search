import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** The skills this package ships, at the package root next to src/. */
export const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "skills")

/**
 * Adds the bundled skills directory to opencode's `skills.paths`, so the
 * skills load wherever the plugin does (npm or a checkout) with nothing to
 * link into ~/.config/opencode. The plugin SDK's Config type doesn't declare
 * `skills` yet, but opencode reads it at runtime.
 */
export function registerSkills(config: object, dir: string = SKILLS_DIR): void {
  const cfg = config as { skills?: { paths?: string[] } }
  cfg.skills ??= {}
  cfg.skills.paths ??= []
  if (!cfg.skills.paths.includes(dir)) cfg.skills.paths.push(dir)
}
