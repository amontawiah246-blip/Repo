import { apiFetch } from "./api";
import React, { useEffect, useRef, useState } from "react";
import { ArrowDownRight, ArrowUpRight, Clock, Coins } from "lucide-react";
import { AMOUNT_PRESETS, EXPIRY_PRESETS, Mode, clampExpiry, fmtHMS, fmtShort } from "./assets";

const read = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } };

/** A button that keeps stepping while it is held (like the + / - in the time picker). */
function Hold({ onStep, className, children, label }: { onStep: () => void; className?: string; children: React.ReactNode; label: string }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fn = useRef(onStep);
  fn.current = onStep;
  const stop = () => { if (timer.current) { clearTimeout(timer.current); clearInterval(timer.current as unknown as number); timer.current = null; } };
  useEffect(() => stop, []);
  const start = (e: React.PointerEvent) => {
    e.preventDefault();
    fn.current();
    stop();
    timer.current = setTimeout(() => { timer.current = setInterval(() => fn.current(), 70) as unknown as ReturnType<typeof setTimeout>; }, 380);
  };
  return (
    <button type="button" className={className} aria-label={label} onPointerDown={start} onPointerUp={stop} onPointerLeave={stop} onPointerCancel={stop}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn.current(); } }}>
      {children}
    </button>
  );
}

interface Props {
  http: string;
  broker: string;
  asset: string;
  assetLabel: string;
  payout?: number;
  closed: boolean;
  mode?: Mode;
  autoOn?: boolean;
  blockReason?: string | null;
  onAi?: () => void;
  onToast: (msg: string) => void;
}

type Side = "buy" | "sell";

export default function TradePanel({ http, broker, asset, assetLabel, payout, closed, blockReason, onToast }: Props) {
  const [seconds, setSecondsState] = useState(() => clampExpiry(Number(read("qx-expiry", "60")) || 60));
  const [amount, setAmountState] = useState(() => read("qx-amount", "10"));
  const [open, setOpen] = useState<null | "time" | "amount">(null);
  const [busy, setBusy] = useState<Side | null>(null);
  const busyRef = useRef(false);

  const setSeconds = (s: number | ((c: number) => number)) =>
    setSecondsState((c) => { const n = clampExpiry(typeof s === "function" ? s(c) : s); write("qx-expiry", String(n)); return n; });
  const setAmount = (v: string) => { setAmountState(v); write("qx-amount", v); };

  const num = parseFloat(amount);

  const place = async (side: Side) => {
    if (blockReason) { onToast(blockReason); return; }
    if (busyRef.current) return; // never send two orders at once
    if (!(num > 0)) { onToast("Enter an amount first"); return; }
    if (closed) { onToast("This market is closed right now"); return; }
    busyRef.current = true;
    setBusy(side);
    setOpen(null);
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 25000);
    try {
      const r = await apiFetch(`${http}/api/trade`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: ctl.signal,
        body: JSON.stringify({ broker: "deriv", asset, side, amount: num, seconds }),
      });
      const d = await r.json();
      if (d.status === "ok") {
        const tid = d.id;
        onToast(`Manual ${side === "buy" ? "RISE" : "FALL"} ${assetLabel} · $${num} placed. Contract #${tid}`);
        // Poll for result
        if (tid) {
          const poll = async () => {
            for (let i = 0; i < 20; i++) {
              await new Promise((res) => setTimeout(res, Math.min(3000, (seconds * 1000) / 4)));
              try {
                const tr = await apiFetch(`${http}/api/trade-result?broker=deriv&id=${tid}&seconds=${seconds}`);
                if (tr.ok) {
                  const td = await tr.json();
                  if (td.status === "ok" && td.result) {
                    const win = td.result === "win";
                    onToast(`${assetLabel} Trade #${tid} ${win ? "WON" : "LOST"} ${td.profit != null ? `(${td.profit >= 0 ? "+" : ""}$${td.profit.toFixed(2)})` : ""}`);
                    return;
                  }
                }
              } catch {
                /* ignore interim errors */
              }
            }
          };
          void poll();
        }
      } else {
        onToast(d.msg || "The broker did not accept the trade");
      }
    } catch (e) {
      onToast((e as Error).name === "AbortError"
        ? "No answer from the broker. Check your open trades before trying again."
        : "Could not reach the bridge. The trade was not sent.");
    } finally {
      clearTimeout(to);
      busyRef.current = false;
      setBusy(null);
    }
  };

  const part = (unit: number, max: number) => {
    const v = Math.floor(seconds / unit) % max;
    return { v, up: () => setSeconds((c) => c + unit), down: () => setSeconds((c) => c - unit) };
  };
  const hh = part(3600, 100), mm = part(60, 60), ss = part(1, 60);

  const sendLabel = (s: Side) => (busy === s ? "Sending…" : s === "buy" ? "RISE" : "FALL");
  const pay = payout && payout > 0 ? `${payout}%` : "95%";

  return (
    <div className="tp">
      {open === "time" && (
        <div className="tp-pop" role="dialog" aria-label="Expiry time">
          <div className="tp-steppers">
            {([["h", hh], ["m", mm], ["s", ss]] as const).map(([k, p], i) => (
              <React.Fragment key={k}>
                {i > 0 && <b className="tp-colon">:</b>}
                <div className="tp-step">
                  <Hold className="tp-pm" onStep={p.up} label={`More ${k}`}><span>+</span></Hold>
                  <div className="tp-val">{String(p.v).padStart(2, "0")}</div>
                  <Hold className="tp-pm" onStep={p.down} label={`Less ${k}`}><span>−</span></Hold>
                </div>
              </React.Fragment>
            ))}
          </div>
          <div className="tp-presets">
            {EXPIRY_PRESETS.map((p) => (
              <button key={p.label} className={seconds === p.sec ? "on" : ""} onClick={() => setSeconds(p.sec)}>{p.label}</button>
            ))}
          </div>
        </div>
      )}
      {open === "amount" && (
        <div className="tp-pop amt" role="dialog" aria-label="Amount">
          <div className="tp-presets amounts">
            {AMOUNT_PRESETS.map((a) => (
              <button key={a} className={num === a ? "on" : ""} onClick={() => { setAmount(String(a)); setOpen(null); }}>${a}</button>
            ))}
            <button onClick={() => setAmount(String(Math.max(1, Math.round((num || 1) / 2 * 100) / 100)))}>½</button>
            <button onClick={() => setAmount(String(Math.min(100000, Math.round((num || 1) * 2 * 100) / 100)))}>2×</button>
          </div>
        </div>
      )}

      <div className="tp-fields">
        <div className="tp-col">
          <span className="tp-lbl">Duration</span>
          <button className={`tp-field time ${open === "time" ? "on" : ""}`} onClick={() => setOpen((o) => (o === "time" ? null : "time"))} aria-label="Expiry time">
            <span>{fmtHMS(seconds)}</span>
            <i><Clock size={20} /></i>
          </button>
        </div>
        <div className="tp-col">
          <span className="tp-lbl">Stake Amount</span>
          <div className={`tp-field ${open === "amount" ? "on" : ""}`}>
            <input value={amount} inputMode="decimal" aria-label="Amount" spellCheck={false}
              onFocus={() => setOpen(null)}
              onChange={(e) => {
                const v = e.target.value.replace(/[^0-9.]/g, "").replace(/^(\d*\.\d{0,2}).*$/, "$1").replace(/(\..*)\./g, "$1");
                setAmount(v);
              }}
              onBlur={() => { if (!(parseFloat(amount) > 0)) setAmount("1"); }} />
            <button className="tp-ico" onClick={() => setOpen((o) => (o === "amount" ? null : "amount"))} aria-label="Amount presets"><Coins size={20} /></button>
          </div>
        </div>
      </div>

      <div className="tp-btns">
        <button className="tp-buy" disabled={!!busy || closed} onClick={() => place("buy")} aria-label="Rise">
          <i><ArrowUpRight size={18} /></i>
          <span><b>{sendLabel("buy")}</b><small>Payout {pay}</small></span>
        </button>
        <button className="tp-sell" disabled={!!busy || closed} onClick={() => place("sell")} aria-label="Fall">
          <i><ArrowDownRight size={18} /></i>
          <span><b>{sendLabel("sell")}</b><small>Payout {pay}</small></span>
        </button>
      </div>
    </div>
  );
}

