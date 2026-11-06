// Deriv trade types (the list from Deriv's own "Trade types" screen) and the one rule that protects your money:
// the bridge can only place Rise/Fall (CALL/PUT) contracts today, so every other type is selectable but cannot trade yet.

export interface DerivPlatform { id: "trader" | "bot" | "smart"; label: string }
export const DERIV_PLATFORMS: DerivPlatform[] = [
  { id: "trader", label: "Deriv Trader" },
  { id: "bot", label: "Deriv Bot" },
  { id: "smart", label: "SmartTrader" },
];

export interface DerivType {
  id: string;
  label: string;
  /** true only when the bridge can really place this contract type */
  tradable: boolean;
}

export const DERIV_TYPES: DerivType[] = [
  { id: "risefall", label: "Rise/Fall", tradable: true },
  { id: "higherlower", label: "Higher/Lower", tradable: false },
  { id: "matchesdiffers", label: "Matches/Differs", tradable: false },
  { id: "evenodd", label: "Even/Odd", tradable: false },
  { id: "accumulators", label: "Accumulators", tradable: false },
  { id: "overunder", label: "Over/Under", tradable: false },
  { id: "multipliers", label: "Multipliers", tradable: false },
  { id: "touch", label: "Touch/No Touch", tradable: false },
  { id: "vanillas", label: "Vanillas", tradable: false },
  { id: "turbos", label: "Turbos", tradable: false },
];

export const DEFAULT_DERIV_TYPE = "risefall";

export const derivTypeOf = (id: string): DerivType => DERIV_TYPES.find((t) => t.id === id) ?? DERIV_TYPES[0];

/** Why a BUY/SELL press must not be sent, or null when it is fine to send. */
export function tradeBlockReason(broker: string, typeId: string): string | null {
  if (broker !== "deriv") return null;
  const t = DERIV_TYPES.find((x) => x.id === typeId);
  if (!t || t.tradable) return null;
  return `${t.label} trading is not built yet. Only Rise/Fall can place trades right now.`;
}
