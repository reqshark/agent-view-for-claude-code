/**
 * The `--name` MAS gives a spawned agent: its branch, made address-safe. Shared
 * by spawn.ts (which passes it) and discovery (which must not mistake it for a
 * user's `/rename` — Claude Code records both as `custom-title`). No `vscode`
 * import, so the data layer can use it.
 */
export function agentNameForBranch(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 48);
}

/** True when `title` is the name MAS launched the agent with — Claude Code may
 *  have suffixed it (`name-word-word`) to keep live names unique. */
export function isSpawnName(title: string, spawnName: string | undefined): boolean {
  return !!spawnName && (title === spawnName || title.startsWith(spawnName + "-"));
}
