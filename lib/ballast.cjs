'use strict';
/**
 * ballast.cjs — context pressure meter + token budget for long-running LLM agents.
 *
 * Register the signals that predict how full your context is getting — memory-file size, log
 * line-counts, session age, task count, anything — each with comfortable/stressed/critical
 * thresholds and a weight. BALLAST blends them into one 0–1 pressure score, maps it to a load
 * mode (FULL / COMPRESSED / EMERGENCY), and pairs with a token Budget so you can shed load on
 * purpose instead of overflowing the window.
 *
 * Pure, dependency-free, fail-open: a signal whose value function throws contributes 0.
 *
 *   const { Meter, Budget, estimateTokens } = require('./ballast.cjs');
 */

const DEFAULT_MODES = { compressed: 0.4, emergency: 0.7 };

/**
 * Map a raw value onto 0–1 using two linear segments:
 *   value <= comfortable        -> 0
 *   comfortable..stressed        -> 0 .. 0.5
 *   stressed..critical           -> 0.5 .. 1
 *   value >= critical            -> 1
 */
function normalize(value, { comfortable = 0, stressed = 1, critical = 2 } = {}) {
  const v = Number(value);
  if (!Number.isFinite(v)) return 0;
  if (v <= comfortable) return 0;
  if (v >= critical) return 1;
  if (v <= stressed) {
    const span = stressed - comfortable;
    return span > 0 ? 0.5 * ((v - comfortable) / span) : 0.5;
  }
  const span = critical - stressed;
  return span > 0 ? 0.5 + 0.5 * ((v - stressed) / span) : 0.5;
}

function readSignalValue(sig) {
  try {
    const raw = typeof sig.value === 'function' ? sig.value() : sig.value;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0; // fail-open: a broken probe contributes nothing, never crashes the reading
  }
}

class Meter {
  /** @param {{ modes?: { compressed: number, emergency: number } }} [opts] */
  constructor(opts = {}) {
    this.signals = [];
    this.modes = { ...DEFAULT_MODES, ...(opts.modes || {}) };
  }

  /** Register a signal: { name, weight=1, value:(number|fn), comfortable, stressed, critical }. Chainable. */
  add(sig) {
    if (!sig || !sig.name) throw new Error('signal requires a name');
    this.signals.push({ weight: 1, comfortable: 0, stressed: 1, critical: 2, ...sig });
    return this;
  }

  /** Per-signal breakdown: [{ name, value, normalized, weight, contribution }]. */
  report() {
    const totalWeight = this.signals.reduce((s, x) => s + (Number(x.weight) || 0), 0) || 1;
    return this.signals.map(sig => {
      const value = readSignalValue(sig);
      const normalized = normalize(value, sig);
      const w = (Number(sig.weight) || 0) / totalWeight;
      return { name: sig.name, value, normalized: +normalized.toFixed(4), weight: +w.toFixed(4), contribution: +(normalized * w).toFixed(4) };
    });
  }

  /** Blended pressure in [0,1] — the weight-normalized sum of every signal's normalized value. */
  pressure() {
    return +this.report().reduce((s, r) => s + r.contribution, 0).toFixed(4);
  }

  /** 'FULL' | 'COMPRESSED' | 'EMERGENCY' from the current pressure (or a supplied value). */
  mode(pressure = this.pressure()) {
    if (pressure >= this.modes.emergency) return 'EMERGENCY';
    if (pressure >= this.modes.compressed) return 'COMPRESSED';
    return 'FULL';
  }

  /** True once pressure crosses the emergency cutoff — a good "flag for compaction" trigger. */
  shouldCompact(pressure = this.pressure()) { return pressure >= this.modes.emergency; }
}

// ── Token budget ─────────────────────────────────────────────────────────────────────────────
/** Fast, tokenizer-free estimate (~chars/4). Replace with your model's real tokenizer for exactness. */
function estimateTokens(text) {
  const s = String(text == null ? '' : text);
  if (!s) return 0;
  return Math.ceil(s.length / 4);
}

class Budget {
  constructor(total) { this.total = Math.max(0, Number(total) || 0); this._spent = 0; }
  /** Add spend (number of tokens, or a string to estimate). Returns remaining. Chainable via remaining(). */
  spend(amountOrText) {
    const n = typeof amountOrText === 'string' ? estimateTokens(amountOrText) : (Number(amountOrText) || 0);
    this._spent += Math.max(0, n);
    return this.remaining();
  }
  spent() { return this._spent; }
  remaining() { return this.total ? Math.max(0, this.total - this._spent) : Infinity; }
  fraction() { return this.total ? Math.min(1, this._spent / this.total) : 0; }
  over() { return this.total ? this._spent > this.total : false; }
  reset() { this._spent = 0; return this; }
}

// ── Signal builders (convenience; all optional, all fail-open) ─────────────────────────────────
const fs = require('fs');
/** Signal from a file's size in bytes (missing file → 0). */
function fileSizeSignal(name, filePath, thresholds = {}) {
  return { name, value: () => { try { return fs.statSync(filePath).size; } catch { return 0; } }, comfortable: 50e3, stressed: 200e3, critical: 500e3, weight: 1, ...thresholds };
}
/** Signal from a file's line count, approximated from size (avg bytesPerLine) to avoid reading big files. */
function lineCountSignal(name, filePath, thresholds = {}) {
  const bpl = thresholds.bytesPerLine || 250;
  return { name, value: () => { try { return Math.round(fs.statSync(filePath).size / bpl); } catch { return 0; } }, comfortable: 500, stressed: 2000, critical: 5000, weight: 1, ...thresholds };
}
/** Signal from minutes since a start timestamp (ISO string or ms). */
function ageMinutesSignal(name, startAt, thresholds = {}) {
  return { name, value: () => { const t = typeof startAt === 'function' ? startAt() : startAt; const ms = typeof t === 'number' ? t : Date.parse(t); return Number.isFinite(ms) ? Math.max(0, (Date.now() - ms) / 60000) : 0; }, comfortable: 30, stressed: 90, critical: 180, weight: 1, ...thresholds };
}

module.exports = { Meter, Budget, normalize, estimateTokens, fileSizeSignal, lineCountSignal, ageMinutesSignal, DEFAULT_MODES };
