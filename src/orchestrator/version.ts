import { execFile } from "child_process";

/**
 * Claude CLI version probe, cached per path. Used to gate flags older CLIs
 * reject at startup — an unknown flag aborts the spawned agent, so a flag is
 * only worth adding when we KNOW the CLI understands it. Any probe failure
 * resolves to undefined (callers must treat that as "too old").
 */
let cached: { path: string; version: string | undefined } | undefined;

export function claudeVersion(claudePath: string): Promise<string | undefined> {
  if (cached && cached.path === claudePath) return Promise.resolve(cached.version);
  return new Promise((resolve) => {
    const done = (version: string | undefined) => {
      cached = { path: claudePath, version };
      resolve(version);
    };
    try {
      const child = execFile(claudePath, ["--version"], { timeout: 3000 }, (err, stdout) => {
        const m = err ? null : /(\d+\.\d+\.\d+)/.exec(String(stdout));
        done(m ? m[1] : undefined);
      });
      child.on("error", () => done(undefined));
    } catch {
      done(undefined);
    }
  });
}

/** True when semver-ish `v` is at least `min` (both "x.y.z"). */
export function versionAtLeast(v: string | undefined, min: string): boolean {
  if (!v) return false;
  const a = v.split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return true;
}

/** First CLI version whose sessions accept `--name` (cross-session messaging
 *  GA) — a stable, human-readable address in ListAgents output. */
export const NAME_FLAG_MIN_VERSION = "2.1.224";
