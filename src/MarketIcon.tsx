import React, { useState } from "react";
import { Asset, FLAG, iconOf } from "./assets";

// Round flags (circle-flags). If one fails to load the flag falls back to a coloured circle with the currency code.
const FLAG_URL = "https://cdn.jsdelivr.net/gh/HatScripts/circle-flags@master/flags/";

function Flag({ code, size, className }: { code: string; size: number; className: string }) {
  const [bad, setBad] = useState(false);
  const cc = FLAG[code];
  if (!cc || bad) {
    return <span className={`flag fb ${className}`} style={{ width: size, height: size }}>{code.slice(0, 2)}</span>;
  }
  return (
    <img className={`flag ${className}`} src={`${FLAG_URL}${cc}.svg`} width={size} height={size} alt={code}
      loading="lazy" draggable={false} onError={() => setBad(true)} />
  );
}

/** Pair icon = two overlapping round flags (like the reference); crypto/commodity/stock = coloured coin. */
export default function MarketIcon({ asset, small = false }: { asset: Asset; small?: boolean }) {
  const ic = iconOf(asset);
  if (ic.kind === "pair") {
    const a = small ? 14 : 18, b = small ? 16 : 21;
    return (
      <span className={`mk-ico pair ${small ? "sm" : ""}`}>
        <Flag code={ic.codes[0]} size={a} className="f1" />
        <Flag code={ic.codes[1]} size={b} className="f2" />
      </span>
    );
  }
  const d = small ? 20 : 25;
  return (
    <span className={`mk-ico coin ${small ? "sm" : ""}`} style={{ width: d, height: d, background: ic.color, fontSize: ic.glyph ? d * 0.6 : d * (ic.text.length > 3 ? 0.24 : 0.31) }}>
      {ic.text}
    </span>
  );
}
