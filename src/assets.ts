// Turn Pocket Option symbols into grouped, readable pairs.
const CCY = ["USD","EUR","GBP","JPY","AUD","CAD","CHF","NZD","TRY","AED","SAR","NGN","ZAR","MXN","BRL","INR","CNH","HKD","SGD","THB","IDR","PHP","EGP","DZD","MAD","TND","LBP","YER","QAR","BHD","OMR","JOD","KES","UAH","RUB","ARS","COP","BDT","PKR","SEK","NOK","DKK","PLN","CZK","HUF","ILS"];
const CRYPTO = ["BTC","ETH","LTC","XRP","BNB","DOGE","SOL","ADA","DOT","MATIC","AVAX","LINK","TRX","TON","BCH","ATOM","UNI","SHIB","PEPE","DASH","ZEC","EOS"];
const METALS_ENERGY = ["XAU","XAG","XPT","XPD","UKBRENT","USCRUDE","BRENT","XNG","NGAS"];

export interface Asset {
  symbol: string;
  name?: string | null;
  payout?: number | null;
  active?: boolean;
  label?: string;
}

export function prettyName(a: Asset): string {
  const otc = /_otc$/i.test(a.symbol) ? " OTC" : "";
  if (a.name) {
    if (otc && !a.name.endsWith(" OTC")) return `${a.name}${otc}`;
    return a.name;
  }
  let sym = a.symbol;
  if (sym.startsWith("frx")) sym = sym.slice(3);
  if (sym.startsWith("cry")) sym = sym.slice(3);
  const base = sym.replace(/^#/, "").replace(/_otc$/i, "");
  if (/^[A-Z]{6}$/.test(base) && CCY.includes(base.slice(0, 3)) && CCY.includes(base.slice(3)))
    return `${base.slice(0, 3)}/${base.slice(3)}${otc}`;
  if (/^[A-Z]{3,5}USD$/.test(base) && CRYPTO.includes(base.slice(0, -3)))
    return `${base.slice(0, -3)}/USD${otc}`;
  return base + otc;
}

export function groupOf(a: Asset): string {
  const sym = a.symbol;
  if (sym.startsWith("R_") || sym.startsWith("1HZ") || sym.startsWith("BOOM") || sym.startsWith("CRASH") || sym.startsWith("JD") || sym === "STPRNG" || sym.startsWith("stpRNG") || sym === "RDBEAR" || sym === "RDBULL") {
    return "Derived Indices";
  }
  const isOtc = /_otc$/i.test(sym);
  const otc = isOtc ? " OTC" : "";
  const base = sym.replace(/^#/, "").replace(/_otc$/i, "").toUpperCase();

  if (sym.startsWith("frxXAU") || sym.startsWith("frxXAG") || sym.startsWith("frxXPD") || sym.startsWith("frxXPT") || sym.startsWith("frxBRO") || sym.startsWith("frxXTI") || METALS_ENERGY.some((c) => base.startsWith(c))) {
    return "Commodities" + otc;
  }
  if (sym.startsWith("cry") || CRYPTO.some((c) => base.startsWith(c) || base.includes(c))) {
    return "Crypto" + otc;
  }
  if (sym.startsWith("frx") || (/^[A-Z]{6}$/.test(base) && CCY.includes(base.slice(0, 3)))) {
    return "Currencies" + otc;
  }
  if (sym.startsWith("#")) return "Stocks" + otc;
  return "Indices & other" + otc;
}

const ORDER = [
  "Derived Indices", "Currencies", "Commodities", "Crypto", "Stocks", "Indices & other",
  "Currencies OTC", "Crypto OTC", "Commodities OTC", "Stocks OTC", "Indices & other OTC"
];

export interface GroupedAssets {
  group: string;
  items: Asset[];
}

export function grouped(list: Asset[]): GroupedAssets[] {
  const map: Record<string, Asset[]> = {};
  for (const a of list) {
    const g = groupOf(a);
    if (!map[g]) map[g] = [];
    map[g].push({ ...a, label: prettyName(a) });
  }
  return ORDER.filter((g) => map[g]).map((g) => ({
    group: g,
    items: map[g].sort((x, y) => (y.payout ?? 0) - (x.payout ?? 0) || (x.label || "").localeCompare(y.label || "")),
  }));
}

// ---------- market picker helpers ----------
export type Kind = "currency" | "crypto" | "commodity" | "stock" | "derived" | "other";

export function kindOf(a: Asset): Kind {
  const g = groupOf(a);
  if (g.startsWith("Derived")) return "derived";
  if (g.startsWith("Currencies")) return "currency";
  if (g.startsWith("Crypto")) return "crypto";
  if (g.startsWith("Commodities")) return "commodity";
  if (g.startsWith("Stocks")) return "stock";
  return "other";
}



/** "EUR/USD OTC" -> { label: "EUR/USD", otc: true } so the picker can draw OTC as a badge. */
export function splitName(a: Asset): { label: string; otc: boolean } {
  const full = prettyName(a);
  const otc = / OTC$/.test(full);
  return { label: otc ? full.slice(0, -4) : full, otc };
}

/** Short form for the header chip: "Volatility 100 Index" -> "Vol 100". */
export function shortName(a: Asset): string {
  return splitName(a).label.replace(/^Volatility /, "Vol ").replace(/ Index$/, "");
}

// Currency code -> ISO country code used by the round flag images.
export const FLAG: Record<string, string> = {
  USD: "us", EUR: "eu", GBP: "gb", JPY: "jp", AUD: "au", CAD: "ca", CHF: "ch", NZD: "nz", TRY: "tr", AED: "ae",
  SAR: "sa", NGN: "ng", ZAR: "za", MXN: "mx", BRL: "br", INR: "in", CNH: "cn", HKD: "hk", SGD: "sg", THB: "th",
  IDR: "id", PHP: "ph", EGP: "eg", DZD: "dz", MAD: "ma", TND: "tn", LBP: "lb", YER: "ye", QAR: "qa", BHD: "bh",
  OMR: "om", JOD: "jo", KES: "ke", UAH: "ua", RUB: "ru", ARS: "ar", COP: "co", BDT: "bd", PKR: "pk", SEK: "se",
  NOK: "no", DKK: "dk", PLN: "pl", CZK: "cz", HUF: "hu", ILS: "il",
};

const COIN_COLOR: Record<string, string> = {
  BCH: "#3042a6", DASH: "#a66f30", DOT: "#3085a6", ETH: "#627eea", LINK: "#30a64a", SOL: "#9945ff", TON: "#0098ea",
  BTC: "#f7931a", LTC: "#345d9d", XRP: "#3b4252", BNB: "#c99a1a", DOGE: "#b59a2a", ADA: "#1f4fc4", MATIC: "#7b3fe4",
  AVAX: "#c93a3a", TRX: "#c4352c", ATOM: "#3a3f66", UNI: "#c4287f", SHIB: "#c4571c", PEPE: "#3a8a3a", ZEC: "#c9942a", EOS: "#3a3f4b",
};
const COIN_GLYPH: Record<string, string> = { ETH: "Ξ", SOL: "S", TON: "T", BTC: "₿", LTC: "Ł", DOGE: "Ð" };

function hashColor(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 42% 36%)`;
}

export type MarketIcon =
  | { kind: "pair"; codes: [string, string] }
  | { kind: "coin"; text: string; color: string; glyph: boolean };

const coin = (text: string, color: string, glyph = false): MarketIcon => ({ kind: "coin", text, color, glyph });
const thousands = (n: string) => (n.length > 3 && n.endsWith("000") ? `${n.slice(0, -3)}K` : n);

// Deriv synthetic indices: Volatility (R_100, 1HZ100V), Boom, Crash, Jump, Step, Range Break.
function derivedIcon(sym: string): MarketIcon {
  const s = sym.toUpperCase();
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(?:R_|1HZ)(\d+)V?$/))) return coin(m[1], "#ff444f");
  if ((m = s.match(/^BOOM(\d+)/))) return coin("B" + thousands(m[1]), "#2f9e5b");
  if ((m = s.match(/^CRASH(\d+)/))) return coin("C" + thousands(m[1]), "#b03a3a");
  if ((m = s.match(/^JD(\d+)/))) return coin("J" + m[1], "#6a4fd8");
  if (s === "STPRNG") return coin("STP", "#2f7fd0");
  if (s === "RDBEAR") return coin("BEAR", "#b03a3a");
  if (s === "RDBULL") return coin("BULL", "#2f9e5b");
  return coin(s.replace(/[^A-Z0-9]/g, "").slice(0, 3) || "?", hashColor(s));
}

export function iconOf(a: Asset): MarketIcon {
  const kind = kindOf(a);
  if (kind === "derived") return derivedIcon(a.symbol);
  const base = a.symbol.replace(/^(frx|cry)/, "").replace(/^#/, "").replace(/[_-]otc$/i, "").toUpperCase();
  if (kind === "currency") return { kind: "pair", codes: [base.slice(0, 3), base.slice(3, 6)] };
  if (kind === "crypto") {
    const t = CRYPTO.find((c) => base.startsWith(c)) || base.slice(0, 3);
    const glyph = COIN_GLYPH[t];
    return coin(glyph || t.slice(0, 3), COIN_COLOR[t] || hashColor(t), !!glyph);
  }
  if (kind === "commodity") {
    const t = base.slice(0, 3);
    return coin(t, t === "XAU" ? "#b8901f" : t === "XAG" ? "#7d8a99" : "#3a4254");
  }
  const t = (a.name || base).replace(/[^A-Za-z0-9]/g, "").slice(0, 3).toUpperCase() || "?";
  return coin(t, hashColor(base));
}

export const TIMEFRAMES = [
  { label: "5s", sec: 5 },
  { label: "15s", sec: 15 },
  { label: "30s", sec: 30 },
  { label: "1m", sec: 60 },
  { label: "2m", sec: 120 },
  { label: "3m", sec: 180 },
  { label: "4m", sec: 240 },
  { label: "5m", sec: 300 },
  { label: "10m", sec: 600 },
  { label: "15m", sec: 900 },
  { label: "30m", sec: 1800 },
  { label: "1h", sec: 3600 },
];

export interface Broker {
  id: string;
  name: string;
  note: string;
  ready: boolean;
  defaultAsset: string;
  auth: "ssid" | "login" | "none";
}

export const BROKERS: Broker[] = [
  { id: "deriv", name: "Deriv", note: "Connected with API Token & App ID", ready: true, defaultAsset: "1HZ100V", auth: "login" },
  { id: "quotex", name: "Quotex", note: "Email / Token login through the bridge", ready: true, defaultAsset: "EURUSD_otc", auth: "login" },
  { id: "iqoption", name: "IQ Option", note: "Email login through the bridge (read-only)", ready: true, defaultAsset: "EURUSD_otc", auth: "login" },
  { id: "pocket", name: "Pocket Option", note: "Connected through SSID", ready: true, defaultAsset: "EURUSD_otc", auth: "ssid" },
  { id: "tradowix", name: "Tradowix", note: "Waiting for provider", ready: false, defaultAsset: "EURUSD_otc", auth: "none" },
  { id: "binolla", name: "Binolla", note: "Waiting for provider", ready: false, defaultAsset: "EURUSD_otc", auth: "none" },
];



// ---------- chart types and trading modes ----------
export type ChartType = "candles" | "hollow" | "bars" | "heikin" | "line" | "area" | "baseline";

export const CHART_TYPES: { id: ChartType; label: string }[] = [
  { id: "candles", label: "Candles" },
  { id: "hollow", label: "Hollow candles" },
  { id: "bars", label: "Bars" },
  { id: "heikin", label: "Heikin Ashi" },
  { id: "line", label: "Line" },
  { id: "area", label: "Area" },
  { id: "baseline", label: "Baseline" },
];

export type Mode = "classic" | "pro" | "ai";

export const MODES: { id: Mode; label: string; note: string }[] = [
  { id: "classic", label: "Classic mode", note: "" },
  { id: "pro", label: "Pro mode", note: "Pro tools are coming soon" },
  { id: "ai", label: "AI Trader", note: "AI Trader is coming soon" },
];

// ---- trading panel -------------------------------------------------------------------------
export const EXPIRY_PRESETS = [
  { label: "S3", sec: 3 }, { label: "S15", sec: 15 }, { label: "S30", sec: 30 },
  { label: "M1", sec: 60 }, { label: "M3", sec: 180 }, { label: "M5", sec: 300 },
  { label: "M30", sec: 1800 }, { label: "H1", sec: 3600 }, { label: "H4", sec: 14400 },
];
export const AMOUNT_PRESETS = [1, 5, 10, 25, 50, 100, 250, 500];
export const EXPIRY_MIN = 3;
export const EXPIRY_MAX = 86400;

const p2 = (n: number) => String(n).padStart(2, "0");
/** 245 -> "00:04:05" */
export const fmtHMS = (s: number) => `${p2(Math.floor(s / 3600))}:${p2(Math.floor((s % 3600) / 60))}:${p2(s % 60)}`;
/** 245 -> "4m 5s" (short text for messages) */
export function fmtShort(s: number) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return [h && `${h}h`, m && `${m}m`, (r || (!h && !m)) && `${r}s`].filter(Boolean).join(" ");
}
export const clampExpiry = (s: number) => Math.min(EXPIRY_MAX, Math.max(EXPIRY_MIN, Math.round(s)));
