/**
 * Model list prices and the cost of a transcript's billed usage. Kept free of
 * `vscode` so the data layer (transcript.ts, discovery.ts) can use it.
 *
 * The table mirrors what Claude Code itself charges in `/cost` — checked
 * against its own `cost-state` transcript records (Opus 5.5, Opus 5, Sonnet 5,
 * Fable 5.1, Haiku 4.5 all agree to the cent). Claude Code requests 1-hour
 * prompt-cache writes, which bill at 2x input; 5-minute writes bill at 1.25x.
 */

/** USD per million tokens. `cacheWrite` is the 5-minute write price. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type ModelFamily = "opus" | "sonnet" | "haiku" | "fable";

/** User overrides from `mas.unattended.pricing`, one price per family. */
export type PriceOverrides = Partial<Record<ModelFamily, ModelPrice>>;

/** Billed usage for one model, counted once per API message. */
export interface BilledUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export function emptyBilled(): BilledUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
}

export function modelFamily(model: string | undefined): ModelFamily {
  const m = (model || "").toLowerCase();
  if (m.includes("fable")) return "fable";
  if (m.includes("opus")) return "opus";
  if (m.includes("haiku")) return "haiku";
  return "sonnet";
}

/** List price for a model id. Unknown ids in a family get its newest price. */
export function listPrice(model: string | undefined): ModelPrice {
  const m = (model || "").toLowerCase();
  switch (modelFamily(m)) {
    case "fable":
      return { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 };
    case "opus":
      // Opus 4.x and Opus 5 kept $5/$25; Opus 5.5 (the default since 2.1.280) is $4/$20.
      return /opus-4|opus-5(?![-.]\d)/.test(m)
        ? { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }
        : { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };
    case "haiku":
      return { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
    default:
      return /sonnet-[34]/.test(m)
        ? { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
        : { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
  }
}

/** USD for one model's billed usage, honoring per-family overrides. */
export function priceUsage(model: string, u: BilledUsage, overrides?: PriceOverrides): number {
  const p = overrides?.[modelFamily(model)] || listPrice(model);
  return (
    (u.input * p.input +
      u.output * p.output +
      u.cacheRead * p.cacheRead +
      u.cacheWrite5m * p.cacheWrite +
      u.cacheWrite1h * p.input * 2) /
    1_000_000
  );
}

/** USD across every model in a usage map. */
export function priceUsageMap(usage: Record<string, BilledUsage> | undefined, overrides?: PriceOverrides): number {
  let total = 0;
  for (const [model, u] of Object.entries(usage || {})) total += priceUsage(model, u, overrides);
  return total;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Billed usage from one API `usage` object. Cache writes split by TTL when
 *  the API reports it; an unsplit total is treated as 5-minute writes. */
export function billedFromApi(u: any): BilledUsage {
  const total = num(u?.cache_creation_input_tokens);
  const cc = u?.cache_creation;
  const w1h = num(cc?.ephemeral_1h_input_tokens);
  let w5m = cc ? num(cc.ephemeral_5m_input_tokens) : total;
  if (w1h + w5m < total) w5m = total - w1h;
  return {
    input: num(u?.input_tokens),
    output: num(u?.output_tokens),
    cacheRead: num(u?.cache_read_input_tokens),
    cacheWrite5m: w5m,
    cacheWrite1h: w1h,
  };
}

export function addBilled(into: BilledUsage, u: BilledUsage): void {
  into.input += u.input;
  into.output += u.output;
  into.cacheRead += u.cacheRead;
  into.cacheWrite5m += u.cacheWrite5m;
  into.cacheWrite1h += u.cacheWrite1h;
}
