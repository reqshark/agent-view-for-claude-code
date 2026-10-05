import { spawn } from "child_process";
import { claudeVersion, LEAN_HELPER_MIN_VERSION, versionAtLeast } from "../orchestrator/version";

export interface LlmOptions {
  claudePath: string;
  model: string;
  cwd?: string;
  timeoutMs?: number;
}

/**
 * Every helper is a pure judgment over text the prompt already carries, so it
 * runs as a bare text model: no tools (transcripts are untrusted input, and
 * since 2.1.285 print mode can default to auto mode, which would run them), no
 * MCP servers or skills (~60K tokens of definitions per call otherwise), a
 * one-line system prompt, and no transcript on disk (the run would otherwise
 * show up in the fleet as an agent). `--tools` is variadic, so it must be
 * followed by another flag — the prompt goes on stdin, never as a positional.
 */
const LEAN_FLAGS = [
  "--tools",
  "",
  "--strict-mcp-config",
  "--disable-slash-commands",
  "--no-session-persistence",
  "--system-prompt",
  "You are a precise judge inside a VS Code extension. Follow the user's instructions and output format exactly.",
];

/**
 * Run Claude Code headlessly (`claude -p --output-format json`) with the prompt
 * piped on stdin (avoids arg-length limits). Returns the model's final text.
 *
 * NOTE: this consumes the user's Claude subscription usage — callers must gate
 * it behind explicit consent (see features/consent.ts).
 */
export async function runClaude(prompt: string, opts: LlmOptions): Promise<string> {
  const lean = versionAtLeast(await claudeVersion(opts.claudePath), LEAN_HELPER_MIN_VERSION);
  return new Promise((resolve, reject) => {
    const child = spawn(
      opts.claudePath,
      ["-p", ...(lean ? LEAN_FLAGS : []), "--output-format", "json", "--model", opts.model],
      { cwd: opts.cwd },
    );

    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("claude timed out"));
    }, opts.timeoutMs ?? 120_000);

    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(err.trim() || `claude exited with code ${code}`));
        return;
      }
      try {
        const json = JSON.parse(out);
        resolve(typeof json.result === "string" ? json.result : out);
      } catch {
        resolve(out); // not JSON-wrapped; return raw
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/** Best-effort extraction of a JSON value from a model response (handles ``` fences / prose). */
export function extractJson<T>(text: string): T | null {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const candidates = [stripped, text];
  const match = text.match(/[[{][\s\S]*[\]}]/);
  if (match) candidates.push(match[0]);
  for (const c of candidates) {
    try {
      return JSON.parse(c) as T;
    } catch {
      /* try next */
    }
  }
  return null;
}
