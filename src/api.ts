// fetch that adds the optional trade PIN (set TRADE_PIN on the server to require one).
const KEY = "qx-pin";
const get = () => { try { return localStorage.getItem(KEY) || ""; } catch { return ""; } };
const set = (v: string) => { try { localStorage.setItem(KEY, v); } catch { /* storage unavailable */ } };

export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const go = () => fetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), ...(get() ? { "x-pin": get() } : {}) } });
  let r = await go();
  if (r.status === 401 && typeof window !== "undefined") {
    const pin = window.prompt("This server needs your trading PIN");
    if (pin) { set(pin); r = await go(); }
  }
  return r;
}
