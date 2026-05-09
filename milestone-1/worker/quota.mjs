// Budget tracking inside the worker process.
//
// In M1 the dispatcher passes a token budget at init time. The worker
// preflights each turn against the remaining budget, refuses if exhausted,
// and reports actual usage on turn_done so the dispatcher can update the
// authoritative quota in the meta DB.
//
// This keeps the worker simple and makes the boundary explicit: the worker
// is a budget *consumer*, not the source of truth.

export class BudgetError extends Error {
  constructor(remaining, requested) {
    super(`budget exhausted: remaining=${remaining}, requested=${requested}`);
    this.kind = 'budget';
    this.remaining = remaining;
    this.requested = requested;
  }
}

export class BudgetTracker {
  /**
   * Wire protocol uses snake_case keys (consistent with the rest of NDJSON).
   * @param {object} init
   * @param {number} [init.remaining_tokens]  total budget for this session
   * @param {boolean} [init.allow_overrun]    if true, log warning instead of refuse
   */
  constructor(init = {}) {
    const remaining = init.remaining_tokens;
    // Default to unlimited if dispatcher doesn't set one (dev / M1 fallback).
    this.remaining = Number.isFinite(remaining) ? remaining : Infinity;
    this.allowOverrun = !!init.allow_overrun;
    this.consumed = 0;
  }

  /**
   * Cheap pre-call check. We don't know exact token count yet — caller
   * provides an estimate (input length / 4 for rough char-to-token).
   */
  preflight(estimateTokens) {
    if (this.remaining === Infinity) return { ok: true };
    if (this.remaining >= estimateTokens) return { ok: true };
    if (this.allowOverrun) return { ok: true, warn: 'overrun' };
    return { ok: false, reason: 'budget_exhausted', remaining: this.remaining };
  }

  /** Record actual usage after the API responds. */
  consume(actualTokens) {
    this.consumed += actualTokens;
    if (this.remaining !== Infinity) {
      this.remaining = Math.max(0, this.remaining - actualTokens);
    }
  }

  snapshot() {
    return {
      remaining: this.remaining === Infinity ? null : this.remaining,
      consumed: this.consumed,
    };
  }
}

/** Rough estimate, char-based; good enough for preflight gates. */
export function estimateTokens(text) {
  if (!text) return 0;
  // ~4 chars per English token, but Chinese is ~1.5 chars/token. Take min.
  return Math.ceil(text.length / 2.5);
}
