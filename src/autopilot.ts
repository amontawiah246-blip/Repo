// Pro mode "AI Trading": scans markets, picks the strongest setup, places the trade, follows the result,
// and stops itself when a risk limit is hit. Pure logic: everything outside world goes through Deps,
// so it can run in the browser today and move to the server later.
import { Candle, Outcome, Side, analyze, outcomeOf } from "./analysis";

export interface AutoConfig {
  stake: number;          // amount per trade
  tfSec: number;          // candle timeframe analysed, also the trade expiry
  minConf: number;        // only trade setups at or above this confidence
  maxTrades: number;      // stop after this many trades
  maxLossStreak: number;  // stop after this many losses in a row
  stopLoss: number;       // stop when the session is this far down (in account currency)
  minPayout: number;      // ignore markets paying less than this percent
  scanCount: number;      // markets checked per scan
}
export const DEFAULT_CFG: AutoConfig = { stake: 10, tfSec: 60, minConf: 60, maxTrades: 10, maxLossStreak: 3, stopLoss: 50, minPayout: 90, scanCount: 60 };

/** What an analyser says about a market: the side, how sure it is, and why (shown in the log). */
export interface Verdict { side: Side; confidence: number; why?: string }
export interface Watch { candles: Candle[]; price(): number | null; /** the broker's clock in seconds, from the latest tick */ clock?(): number | null; close(): void }
/** An analyser answer: a setup, or { none } with the reason there is no setup. null = the market could not be read. */
export type Look = Verdict | { none: string } | null;
export interface MarketRef { symbol: string; label: string; payout?: number | null; active?: boolean }
export interface Deps {
  assets(): MarketRef[];
  watch(symbol: string, tfSec: number): Promise<Watch>;
  place(symbol: string, side: Side, stake: number, seconds: number): Promise<{ ok: boolean; msg: string; id?: string }>;
  /** The broker's own verdict on a placed trade. Resolve null when it cannot be read; the engine then estimates from the price. */
  result?(id: string, seconds: number): Promise<{ outcome: Outcome; profit: number | null } | null>;
  /** Reads a market (all candles, the last may still be forming). Resolve null when there is no setup. Default: the local indicator model. */
  analyze?(symbol: string, candles: Candle[], tfSec: number, nowSec?: number | null): Promise<Look>;
  sleep(ms: number): Promise<void>;
  onPick?(symbol: string): void;
}

export type Phase = "idle" | "scanning" | "confirming" | "running" | "cooldown" | "stopped";
export interface ScanRow { symbol: string; label: string; payout?: number | null; state: "wait" | "scan" | "done" | "fail"; side?: Side; conf?: number; why?: string }
export interface TradeInfo { symbol: string; label: string; side: Side; conf: number; stake: number; seconds: number; endsAt: number }
export interface AutoStats { trades: number; wins: number; losses: number; draws: number; streak: number; pnl: number; estimated: number }
export interface LogLine { t: number; text: string; kind: "info" | "win" | "loss" | "warn" }
export interface AutoState { phase: Phase; round: number; scan: ScanRow[]; trade: TradeInfo | null; stats: AutoStats; log: LogLine[]; stopReason: string; focus: string; startedAt: number }

const RESCAN_MS = 20000, COOLDOWN_MS = 5000, SETTLE_MS = 1500, CONCURRENCY = 6;
const clean = (cs: Candle[]) => cs.slice(0, -1); // the last candle is still forming

export class Autopilot {
  state: AutoState = { phase: "idle", round: 0, scan: [], trade: null, stats: { trades: 0, wins: 0, losses: 0, draws: 0, streak: 0, pnl: 0, estimated: 0 }, log: [], stopReason: "", focus: "", startedAt: Date.now() };
  private subs = new Set<() => void>();
  private stopped = false;
  private stopR!: () => void;
  private stopP = new Promise<void>((r) => { this.stopR = r; });
  private recent: string[] = [];

  constructor(private deps: Deps, public cfg: AutoConfig) {}

  subscribe(fn: () => void) { this.subs.add(fn); return () => this.subs.delete(fn); }
  private set(p: Partial<AutoState>) { this.state = { ...this.state, ...p }; this.subs.forEach((f) => f()); }
  private log(text: string, kind: LogLine["kind"] = "info") { this.set({ log: [{ t: Date.now(), text, kind }, ...this.state.log].slice(0, 40) }); }
  private async wait(ms: number) {
    await Promise.race([this.deps.sleep(ms), this.stopP]);
  }

  get running() { return !this.stopped && this.state.phase !== "idle" && this.state.phase !== "stopped"; }

  stop(reason = "Stopped by you") {
    if (this.state.phase === "stopped") return;
    this.stopped = true;
    this.stopR();
    this.set({ phase: "stopped", trade: null, stopReason: reason });
    this.log(reason, "warn");
  }

  async start() {
    if (this.state.phase !== "idle") return;
    this.set({ phase: "scanning" });
    this.log(`AI Trading on: ${this.cfg.tfSec}s trades, min confidence ${this.cfg.minConf}%`);
    let badScans = 0, badPlaces = 0;
    while (!this.stopped) {
      const lim = this.limit();
      if (lim) return this.stop(lim);
      const pool = this.pool();
      this.set({ phase: "scanning", round: this.state.round + 1, trade: null, scan: pool.map((m) => ({ symbol: m.symbol, label: m.label, payout: m.payout, state: "wait" as const })) });
      if (!pool.length) { this.log("No open markets match your payout filter", "warn"); await this.wait(RESCAN_MS); continue; }

      const rows = await this.scan(pool);
      if (this.stopped) return;
      const ok = rows.filter((r) => r.state === "done");
      if (!ok.length) {
        if (++badScans >= 5) return this.stop("Could not read market data 5 times in a row. Check the bridge.");
        this.log("Could not read any market this round, retrying", "warn");
        await this.wait(RESCAN_MS); continue;
      }
      badScans = 0;
      const best = ok.filter((r) => (r.conf ?? 0) >= this.cfg.minConf).sort((a, b) => (b.conf ?? 0) - (a.conf ?? 0))[0];
      if (!best) {
        const top = Math.max(...ok.map((r) => r.conf ?? 0));
        this.log(top <= 0
          ? `Checked ${ok.length} markets, no tradeable setup. ${ok.slice(0, 3).map((r) => `${r.label}: ${r.why ?? "-"}`).join(" | ")}`
          : `Best setup is ${top}%, below your ${this.cfg.minConf}% minimum. Checking again soon`);
        this.set({ phase: "cooldown" });
        await this.wait(RESCAN_MS); continue;
      }

      const res = await this.execute(best);
      if (this.stopped) return;
      if (res === "error") { if (++badPlaces >= 3) return this.stop("The broker rejected 3 trades in a row. Check the account and try again."); }
      else if (res === "placed") badPlaces = 0;
      this.set({ phase: "cooldown", trade: null });
      await this.wait(COOLDOWN_MS);
    }
  }

  private limit(): string {
    const s = this.state.stats, c = this.cfg;
    if (s.trades >= c.maxTrades) return `Reached the limit of ${c.maxTrades} trades`;
    if (s.streak >= c.maxLossStreak) return `${s.streak} losses in a row, stopping to protect your balance`;
    if (s.pnl <= -c.stopLoss) return `Loss limit of ${c.stopLoss} reached`;
    return "";
  }

  private pool(): MarketRef[] {
    const open = this.deps.assets()
      .filter((a) => a.active !== false && (a.payout ?? 0) >= this.cfg.minPayout)   // unknown payout counts as too low
      .sort((a, b) => (b.payout ?? 0) - (a.payout ?? 0));
    const fresh = open.filter((a) => !this.recent.includes(a.symbol));   // rest the two markets traded last, unless nothing else is open
    const el = fresh.length ? fresh : open;
    if (!el.length) return [];
    const n = Math.min(this.cfg.scanCount, el.length), start = (this.state.round * this.cfg.scanCount) % el.length;   // rotate so every market gets looked at
    return Array.from({ length: n }, (_, i) => el[(start + i) % el.length]);
  }

  private async look(symbol: string, candles: Candle[], nowSec?: number | null): Promise<Look> {
    if (this.deps.analyze) return this.deps.analyze(symbol, candles, this.cfg.tfSec, nowSec);
    return analyze(clean(candles));
  }

  private async scan(pool: MarketRef[]): Promise<ScanRow[]> {
    const rows = this.state.scan.map((r) => ({ ...r }));
    const upd = (i: number, p: Partial<ScanRow>) => { Object.assign(rows[i], p); this.set({ scan: rows.map((r) => ({ ...r })) }); };
    let next = 0;
    const worker = async () => {
      while (!this.stopped) {
        const i = next++; if (i >= pool.length) return;
        upd(i, { state: "scan" });
        let w: Watch | null = null;
        try {
          w = await this.deps.watch(pool[i].symbol, this.cfg.tfSec);
          const a = await this.look(pool[i].symbol, w.candles, w.clock?.());
          if (!a) upd(i, { state: "fail" });
          else if ("none" in a) upd(i, { state: "done", conf: 0, why: a.none });
          else upd(i, { state: "done", side: a.side, conf: a.confidence, why: a.why });
        } catch { upd(i, { state: "fail" }); }
        finally { w?.close(); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pool.length) }, worker));
    return rows;
  }

  private async execute(pick: ScanRow): Promise<"placed" | "skipped" | "error"> {
    const { stake, tfSec, minConf } = this.cfg;
    this.set({ phase: "confirming" });
    this.set({ focus: pick.symbol });
    this.deps.onPick?.(pick.symbol);
    this.log(`Best setup: ${pick.label} ${pick.side === "buy" ? "BUY" : "SELL"} ${pick.conf}%${pick.why ? " · " + pick.why : ""}`);
    let w: Watch | null = null;
    try {
      w = await this.deps.watch(pick.symbol, tfSec);
      const a0 = await this.look(pick.symbol, w.candles, w.clock?.());      // look again right before the trade
      const a = a0 && "side" in a0 ? a0 : null;
      if (!a || a.side !== pick.side || a.confidence < minConf - 5) {
        this.log(`${pick.label}: the setup faded, skipping`, "warn");
        this.recent = [pick.symbol, ...this.recent].slice(0, 2);
        return "skipped";
      }
      const entry = w.price() ?? w.candles[w.candles.length - 1].close;
      const placed = await this.deps.place(pick.symbol, a.side, stake, tfSec);
      if (!placed.ok) { this.log(`Trade not placed: ${placed.msg}`, "warn"); return "error"; }
      this.recent = [pick.symbol, ...this.recent].slice(0, 2);
      const info: TradeInfo = { symbol: pick.symbol, label: pick.label, side: a.side, conf: a.confidence, stake, seconds: tfSec, endsAt: Date.now() + tfSec * 1000 };
      this.set({ phase: "running", trade: info, stats: { ...this.state.stats, trades: this.state.stats.trades + 1 } });
      this.log(`Placed ${a.side === "buy" ? "BUY" : "SELL"} ${pick.label} · ${stake} · ${tfSec}s`);
      // Ask the broker for its own verdict first; it answers once the trade has settled.
      let official: { outcome: Outcome; profit: number | null } | null = null;
      if (placed.id && this.deps.result) {
        official = await Promise.race([this.deps.result(placed.id, tfSec).catch(() => null), this.stopP.then(() => null)]);
      }
      if (this.stopped) return "placed";
      if (official) { this.settle(official.outcome, pick, official.profit, true); return "placed"; }
      // No official answer: wait out the expiry and compare the live price with the entry price.
      await this.wait(Math.max(0, info.endsAt + SETTLE_MS - Date.now()));
      if (this.stopped) return "placed";
      const exit = w.price();
      let out: Outcome | "unknown" = "unknown";
      if (exit != null) out = outcomeOf(a.side, entry, exit);
      this.settle(out, pick, null, false);
      return "placed";
    } catch (e) {
      this.log(`Trade step failed: ${(e as Error).message || "error"}`, "warn");
      return "error";
    } finally { w?.close(); }
  }

  private settle(out: Outcome | "unknown", pick: ScanRow, profit: number | null, official: boolean) {
    const s = { ...this.state.stats };
    const pay = (pick.payout && pick.payout > 0 ? pick.payout : 80) / 100;
    const tag = official ? "" : " (estimated)";
    if (!official) s.estimated++;
    if (out === "win") {
      const g = profit != null && profit > 0 ? profit : this.cfg.stake * pay;
      s.wins++; s.streak = 0; s.pnl += g; this.log(`WIN ${pick.label} +${g.toFixed(2)}${tag}`, "win");
    } else if (out === "loss") {
      const l = profit != null && profit < 0 ? -profit : this.cfg.stake;
      s.losses++; s.streak++; s.pnl -= l; this.log(`LOSS ${pick.label} -${l.toFixed(2)}${tag}`, "loss");
    } else if (out === "draw") { s.draws++; this.log(`DRAW ${pick.label}, stake returned${tag}`); }
    else this.log(`Could not read the result of ${pick.label}`, "warn");
    s.pnl = Math.round(s.pnl * 100) / 100;
    this.set({ stats: s, trade: null });
  }
}
