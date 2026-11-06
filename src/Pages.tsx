import React, { useState } from 'react';
import { BROKERS } from "./assets";

export interface StatusData {
  ready?: boolean;
  error?: string;
  balance?: number | null;
  demo?: boolean;
  assets?: number;
  configured?: boolean;
}

interface HomeProps {
  status: StatusData | null;
  brokerName: string;
  onOpenChart: () => void;
  onSwitchAccount?: (demo: boolean) => void;
}

export function Home({ status, brokerName, onOpenChart, onSwitchAccount }: HomeProps) {
  return (
    <div className="page">
      <h1>QuantX</h1>
      <div className="card">
        <div className="row">
          <span>{brokerName}</span>
          <b className={status?.ready ? "up" : "down"}>
            {status?.ready ? "Connected" : status ? "Starting / Connecting..." : "Offline"}
          </b>
        </div>
        <div className="row"><span>Account</span>
          {status?.ready && onSwitchAccount
            ? <span className="acctsw"><button className={status.demo ? "on" : ""} onClick={() => !status.demo && onSwitchAccount(true)}>Demo</button><button className={!status.demo ? "on real" : ""} onClick={() => status.demo && onSwitchAccount(false)}>Real</button></span>
            : <b>{status?.ready ? (status.demo ? "Demo" : "Real") : "—"}</b>}
        </div>
        <div className="row"><span>Balance</span><b>{status?.balance != null ? `$${status.balance.toLocaleString(undefined, { minimumFractionDigits: 2 })}` : "—"}</b></div>
        <div className="row"><span>Assets</span><b>{status?.assets ?? "—"}</b></div>
        {status?.error && <p className="warn">{status.error}</p>}
      </div>
      <button className="primary" onClick={onOpenChart}>Open chart</button>
    </div>
  );
}

export function Signals() {
  return (
    <div className="page">
      <h1>Signals</h1>
      <p className="muted">Strategy signals will live here, apart from the chart. Nothing is generated yet.</p>
    </div>
  );
}

interface ApiProps {
  bridge: string;
  setBridge: (v: string) => void;
  broker: string;
  status: StatusData | null;
}

export function Api({ bridge, setBridge, broker, status }: ApiProps) {
  const [ssidInput, setSsidInput] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  const saveSsid = async () => {
    if (!ssidInput.trim()) return;
    setSaving(true);
    setMsg('');
    try {
      const res = await fetch('/api/set-ssid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ssid: ssidInput.trim() }),
      });
      const data = await res.json();
      setMsg(data.msg || 'SSID saved successfully');
    } catch (e) {
      setMsg(`Failed to save: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  const saveLogin = async () => {
    let cleanSsid = ssidInput.trim();
    if (cleanSsid.includes('"session"')) {
      const match = cleanSsid.match(/"session"\s*:\s*"([^"]+)"/);
      if (match) cleanSsid = match[1];
    }
    const hasSsid = !!cleanSsid;
    if (!hasSsid && (!email.trim() || !password)) return;
    setSaving(true);
    setMsg('');
    try {
      const res = await fetch('/api/set-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ broker, email: email.trim(), password, ssid: hasSsid ? cleanSsid : '' }),
      });
      const data = await res.json();
      setMsg(data.msg || 'Saved');
      setPassword('');
      if (hasSsid) setSsidInput('');
    } catch (e) {
      setMsg(`Failed to save: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page">
      <h1>API & Cloud Bridge</h1>
      <div className="card">
        <div className="row">
          <span>Bridge Mode</span>
          <b className="up">Cloud Server (No Laptop Needed)</b>
        </div>
      </div>

      <label className="field">Bridge host address
        <input value={bridge} onChange={(e) => setBridge(e.target.value)} spellCheck={false} />
      </label>

      {broker === 'deriv' ? (
        <div className="field">
          <span>Deriv Personal Access Token (PAT)</span>
          <textarea rows={2} className="search" placeholder="Paste your Deriv API Key (pat_...)"
            value={ssidInput} onChange={(e) => setSsidInput(e.target.value)}
            style={{ fontFamily: 'monospace', fontSize: '11px', marginBottom: '6px', resize: 'vertical' }} />
          <button className="primary" style={{ marginTop: '8px' }}
            disabled={saving || !ssidInput.trim()} onClick={saveLogin}>
            {saving ? 'Connecting...' : 'Save & Connect Deriv'}
          </button>
          {status?.error && <p className="warn" style={{ marginTop: '6px' }}>{status.error}</p>}
          {msg && <p className="muted" style={{ marginTop: '6px' }}>{msg}</p>}
        </div>
      ) : broker === 'quotex' || broker === 'iqoption' ? (
        <div className="field">
          <span>{broker === 'iqoption' ? 'IQ Option login' : 'Quotex token or login (practice account is used)'}</span>
          <textarea rows={2} className="search" placeholder={broker === 'quotex' ? 'Paste Quotex session token or 42["authorization",{"session":"..."}]' : 'Paste IQ Option ssid cookie'}
            value={ssidInput} onChange={(e) => setSsidInput(e.target.value)}
            style={{ fontFamily: 'monospace', fontSize: '11px', marginBottom: '6px', resize: 'vertical' }} />
          <input type="email" autoComplete="username" placeholder="Or Email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input type="password" autoComplete="current-password" placeholder="Or Password" value={password} onChange={(e) => setPassword(e.target.value)} style={{ marginTop: '6px' }} />
          <button className="primary" style={{ marginTop: '8px' }}
            disabled={saving || !(ssidInput.trim() || (email.trim() && password))} onClick={saveLogin}>
            {saving ? 'Connecting...' : `Save & Connect ${broker === 'iqoption' ? 'IQ Option' : 'Quotex'}`}
          </button>
          {status?.error && <p className="warn" style={{ marginTop: '6px' }}>{status.error}</p>}
          {msg && <p className="muted" style={{ marginTop: '6px' }}>{msg}</p>}
        </div>
      ) : (
      <div className="field">
        <span>Pocket Option SSID</span>
        <textarea
          rows={3}
          placeholder='Update session: 42["auth",{"session":"...","isDemo":1,...}]'
          value={ssidInput}
          onChange={(e) => setSsidInput(e.target.value)}
          className="search"
          style={{ fontFamily: 'monospace', fontSize: '11px', resize: 'vertical' }}
        />
        <button
          className="primary"
          style={{ marginTop: '8px' }}
          disabled={saving || !ssidInput.trim()}
          onClick={saveSsid}
        >
          {saving ? 'Updating...' : 'Update & Reconnect Session'}
        </button>
        {msg && <p className="muted" style={{ marginTop: '6px' }}>{msg}</p>}
      </div>

      )}

      <div className="card">
        {BROKERS.map((b) => (
          <div className="row" key={b.id}>
            <span>{b.name}<small>{b.note}</small></span>
            <b className={b.ready ? "up" : "muted"}>{b.ready ? "Active" : "Soon"}</b>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Menu() {
  return (
    <div className="page">
      <h1>Menu</h1>
      <p className="muted">Settings, trade history and bot controls will be added here as separate screens.</p>
    </div>
  );
}
