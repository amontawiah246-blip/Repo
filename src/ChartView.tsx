import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { createChart, CrosshairMode, IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";
import { BROKERS, ChartType } from "./assets";

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}:` : "") + `${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
const decimalsFor = (p: number) => (p < 10 ? 5 : p < 1000 ? 3 : 2);

const UP = "#22c55e";
const DOWN = "#ef4444";
const ACCENT = "#4d7cff";

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface Quote {
  price: number | null;
  up: boolean;
  left: number; // seconds left in the forming candle
  dec: number;
  live: boolean;
}

/** What the chart menu can ask the chart to do. A string result is an error message to show the user. */
export interface ChartHandle {
  getQuote: () => Quote;
  screenshot: () => Promise<string | void>;
  fullscreen: () => Promise<string | void>;
}

interface ChartViewProps {
  wsBase: string;
  broker: string;
  asset: string;
  tf: number;
  reloadKey: number;
  chartType: ChartType;
}

const isLine = (t: ChartType) => t === "line" || t === "area" || t === "baseline";

// Heikin Ashi candle from a normal candle and the previous Heikin Ashi candle.
function haNext(c: Candle, prev?: Candle): Candle {
  const close = (c.open + c.high + c.low + c.close) / 4;
  const open = prev ? (prev.open + prev.close) / 2 : (c.open + c.close) / 2;
  return { time: c.time, open, high: Math.max(c.high, open, close), low: Math.min(c.low, open, close), close };
}

const ChartView = forwardRef<ChartHandle, ChartViewProps>(function ChartView({ wsBase, broker, asset, tf, reloadKey, chartType }, ref) {
  const box = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"connecting" | "live" | "error">("connecting");
  const [msg, setMsg] = useState("");
  const [tickRate, setTickRate] = useState(0);

  const typeRef = useRef<ChartType>(chartType);
  typeRef.current = chartType;
  const stateRef = useRef(state);
  stateRef.current = state;
  const ctl = useRef<{ setType: (t: ChartType) => void; quote: () => Omit<Quote, "live">; shot: () => HTMLCanvasElement } | null>(null);

  useImperativeHandle(ref, () => ({
    getQuote: () => ({ ...(ctl.current?.quote() ?? { price: null, up: true, left: tf, dec: 5 }), live: stateRef.current === "live" }),
    screenshot: async () => {
      const canvas = ctl.current?.shot();
      if (!canvas) return "The chart is not ready yet";
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const name = `quantx-${asset}-${tf}s-${stamp}.png`;
      const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, "image/png"));
      if (!blob) return "Could not create the screenshot";
      try {
        const file = new File([blob], name, { type: "image/png" });
        if (navigator.canShare?.({ files: [file] })) {
          await navigator.share({ files: [file], title: name }); // phone share sheet: save to gallery, send, etc.
          return;
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    },
    fullscreen: async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
      } catch {
        return "Fullscreen is blocked here. Open the app in its own browser tab to use it.";
      }
    },
  }), [tf, asset]);

  useEffect(() => {
    setState("connecting");
    setMsg("");
    if (!box.current) return;

    const chart: IChartApi = createChart(box.current, {
      autoSize: true,
      layout: { background: { color: "#0a1020" }, textColor: "#7d89a8", fontSize: 12 },
      grid: { vertLines: { color: "#111a30" }, horzLines: { color: "#111a30" } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: tf < 60, rightOffset: 8, barSpacing: 11, minBarSpacing: 3 },
    });

    let cs: Candle[] = [];   // candles exactly as the bridge sent them
    let ha: Candle[] = [];   // Heikin Ashi version, kept in step with cs while that chart type is shown
    let type: ChartType = typeRef.current;
    let last: Candle | null = null;
    let dec: number | null = null;

    const makeSeries = (t: ChartType): ISeriesApi<any> => {
      const common = { lastValueVisible: false, priceLineVisible: false };
      switch (t) {
        case "bars":
          return chart.addBarSeries({ upColor: UP, downColor: DOWN, ...common });
        case "line":
          return chart.addLineSeries({ color: ACCENT, lineWidth: 2, ...common });
        case "area":
          return chart.addAreaSeries({ lineColor: ACCENT, topColor: "rgba(77,124,255,0.35)", bottomColor: "rgba(77,124,255,0)", lineWidth: 2, ...common });
        case "baseline":
          return chart.addBaselineSeries({
            baseValue: { type: "price", price: cs.length ? cs[cs.length - 1].close : 0 },
            topLineColor: UP, bottomLineColor: DOWN,
            topFillColor1: "rgba(34,197,94,0.28)", topFillColor2: "rgba(34,197,94,0.04)",
            bottomFillColor1: "rgba(239,68,68,0.04)", bottomFillColor2: "rgba(239,68,68,0.28)",
            lineWidth: 2, ...common,
          });
        case "hollow": // up candles are outlines, down candles are filled
          return chart.addCandlestickSeries({
            upColor: "rgba(0,0,0,0)", downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN,
            wickUpColor: UP, wickDownColor: DOWN, borderVisible: true, ...common,
          });
        default:
          return chart.addCandlestickSeries({
            upColor: UP, downColor: DOWN, wickUpColor: UP, wickDownColor: DOWN, borderVisible: false, ...common,
          });
      }
    };

    let series: ISeriesApi<any> = makeSeries(type);

    const shown = (i: number) => (type === "heikin" ? ha[i] : cs[i]);
    const pointFor = (c: Candle) =>
      isLine(type)
        ? { time: c.time as UTCTimestamp, value: c.close }
        : { time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close };

    const applyPrecision = () => {
      if (dec) series.applyOptions({ priceFormat: { type: "price", precision: dec, minMove: 1 / 10 ** dec } });
    };

    const setPrecision = (p: number) => {
      if (dec) return;
      dec = decimalsFor(p);
      applyPrecision();
    };

    // Draw every candle again (history arrived, or the chart type changed).
    const render = () => {
      if (type === "heikin") {
        ha = [];
        for (let i = 0; i < cs.length; i++) ha.push(haNext(cs[i], ha[i - 1]));
      }
      series.setData(cs.map((_, i) => pointFor(shown(i))));
      if (type === "baseline" && cs.length) series.applyOptions({ baseValue: { type: "price", price: cs[cs.length - 1].close } });
      last = cs.length ? cs[cs.length - 1] : null;
    };

    // One live candle changed (or a new one opened).
    const applyCandle = (c: Candle) => {
      const n = cs.length;
      if (n && cs[n - 1].time === c.time) cs[n - 1] = c;
      else if (!n || c.time > cs[n - 1].time) cs.push(c);
      else return;
      const i = cs.length - 1;
      if (type === "heikin") ha[i] = haNext(cs[i], ha[i - 1]);
      series.update(pointFor(shown(i)));
      last = c;
    };

    let ticks = 0;
    let closed = false;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const place = () => {
      const el = pill.current;
      if (!el || !last) return;
      const y = series.priceToCoordinate(last.close);
      if (y == null) { el.style.display = "none"; return; }
      const left = tf - (Math.floor(Date.now() / 1000) % tf);
      el.style.display = "flex";
      el.style.top = `${y}px`;
      el.dataset.up = last.close >= last.open ? "1" : "0";
      if (el.children[0]) el.children[0].textContent = clock(left);
      if (el.children[1]) el.children[1].textContent = last.close.toFixed(dec ?? 5);
    };

    const setType = (t: ChartType) => {
      if (t === type) return;
      chart.removeSeries(series);
      type = t;
      series = makeSeries(t);
      applyPrecision();
      render();
      place();
    };

    ctl.current = {
      setType,
      quote: () => ({
        price: last ? last.close : null,
        up: last ? last.close >= last.open : true,
        left: tf - (Math.floor(Date.now() / 1000) % tf),
        dec: dec ?? 5,
      }),
      shot: () => chart.takeScreenshot(),
    };

    const ticker = setInterval(place, 250);
    const meter = setInterval(() => { setTickRate(ticks); ticks = 0; }, 1000);

    const open = () => {
      try {
        ws = new WebSocket(`${wsBase}/ws?broker=${encodeURIComponent(broker)}&asset=${encodeURIComponent(asset)}&tf=${tf}`);
        ws.onmessage = (e) => {
          if (closed) return; // a late message from the broker we just left must never paint on the new chart
          try {
            const m = JSON.parse(e.data);
            if (m.type === "history" && Array.isArray(m.candles) && m.candles.length) {
              // A refresh must never take away candles the chart already shows (that is how holes appeared).
              if (m.resync && last && m.candles[m.candles.length - 1].time < last.time) return;
              setPrecision(m.candles[m.candles.length - 1].close);
              cs = m.candles.map((c: Candle) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
              render();
              if (!m.resync) {
                const len = cs.length;
                chart.timeScale().setVisibleLogicalRange({ from: len - 35, to: len + 4 });
              }
              setState("live");
              place();
            } else if (m.type === "tick") {
              setPrecision(m.price);
              if (last && m.candle.time < last.time) return; // stale tick for a candle that already closed
              applyCandle(m.candle);
              ticks++;
              setState("live");
              place();
            } else if (m.type === "error") {
              setState("error");
              setMsg(m.msg);
            } else if (m.type === "info") {
              setMsg(m.msg);
            }
          } catch {
            // ignore parsing error
          }
        };

        ws.onclose = () => {
          if (!closed) {
            setState("connecting");
            retry = setTimeout(open, 3000);
          }
        };

        ws.onerror = () => {
          if (!closed) {
            setState("connecting");
          }
        };
      } catch {
        if (!closed) {
          setState("connecting");
          retry = setTimeout(open, 3000);
        }
      }
    };

    open();

    return () => {
      closed = true;
      ctl.current = null;
      clearTimeout(retry);
      clearInterval(ticker);
      clearInterval(meter);
      if (ws) ws.close();
      chart.remove();
    };
  }, [wsBase, broker, asset, tf, reloadKey]);

  // Switching the chart type keeps the data and the connection; only the drawing changes.
  useEffect(() => { ctl.current?.setType(chartType); }, [chartType]);

  return (
    <div className="chart-wrap">
      <div ref={box} className="chart" />
      <div ref={pill} className="pill" style={{ display: "none" }}><span /><span /></div>
      {state !== "live" && (
        <div className="overlay">
          <b>{state === "error" ? "Bridge error" : "Waiting for live data"}</b>
          <span>{msg || `Connecting to ${BROKERS.find((b) => b.id === broker)?.name || broker}...`}</span>
        </div>
      )}
      {state === "live" && (
        <div className="rate" style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <span>{tickRate} updates/s</span>
          <span style={{ color: "#7d89a8", borderLeft: "1px solid #1e293b", paddingLeft: "8px" }}>
            {new Date().toISOString().substring(11, 19)} UTC+0
          </span>
        </div>
      )}
    </div>
  );
});

export default ChartView;
