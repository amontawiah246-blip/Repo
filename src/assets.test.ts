import test from 'node:test';
import assert from 'node:assert/strict';
import { prettyName, groupOf, grouped, TIMEFRAMES, BROKERS, kindOf, splitName, shortName, iconOf, CHART_TYPES, MODES } from './assets';

test('prettyName formats currency pairs correctly', () => {
  assert.equal(prettyName({ symbol: 'EURUSD_otc' }), 'EUR/USD OTC');
  assert.equal(prettyName({ symbol: 'GBPJPY_otc' }), 'GBP/JPY OTC');
  assert.equal(prettyName({ symbol: 'EURUSD' }), 'EUR/USD');
  assert.equal(prettyName({ symbol: 'frxEURUSD' }), 'EUR/USD');
});

test('prettyName formats crypto pairs correctly', () => {
  assert.equal(prettyName({ symbol: 'BTCUSD_otc' }), 'BTC/USD OTC');
  assert.equal(prettyName({ symbol: 'ETHUSD_otc' }), 'ETH/USD OTC');
  assert.equal(prettyName({ symbol: 'cryBTCUSD' }), 'BTC/USD');
});

test('prettyName uses the name a broker provides', () => {
  assert.equal(prettyName({ symbol: '#AAPL_otc', name: 'Apple' }), 'Apple OTC');
  assert.equal(prettyName({ symbol: 'R_100', name: 'Volatility 100 Index' }), 'Volatility 100 Index');
});

test('groupOf categorizes assets', () => {
  assert.equal(groupOf({ symbol: 'EURUSD_otc' }), 'Currencies OTC');
  assert.equal(groupOf({ symbol: 'BTCUSD_otc' }), 'Crypto OTC');
  assert.equal(groupOf({ symbol: 'XAUUSD_otc' }), 'Commodities OTC');
  assert.equal(groupOf({ symbol: '#AAPL_otc' }), 'Stocks OTC');
  assert.equal(groupOf({ symbol: 'R_100' }), 'Derived Indices');
  assert.equal(groupOf({ symbol: 'frxEURUSD' }), 'Currencies');
});

test('grouped orders and sorts by payout descending', () => {
  const assets = [
    { symbol: 'GBPUSD_otc', payout: 80, active: true },
    { symbol: 'EURUSD_otc', payout: 92, active: true },
    { symbol: 'USDJPY_otc', payout: 85, active: true },
  ];
  const result = grouped(assets);
  assert.equal(result.length, 1);
  assert.equal(result[0].group, 'Currencies OTC');
  assert.equal(result[0].items[0].symbol, 'EURUSD_otc');
  assert.equal(result[0].items[1].symbol, 'USDJPY_otc');
  assert.equal(result[0].items[2].symbol, 'GBPUSD_otc');
});

test('timeframes contain 5s, 15s, 30s, 1m, 2m, 3m, 4m, 5m, 10m, 15m, 30m, 1h', () => {
  const labels = TIMEFRAMES.map((t) => t.label);
  assert.deepEqual(labels, ['5s', '15s', '30s', '1m', '2m', '3m', '4m', '5m', '10m', '15m', '30m', '1h']);
});

test('brokers: Deriv, Quotex, IQ Option and Pocket Option are ready', () => {
  const by = (id: string) => BROKERS.find((b) => b.id === id);
  for (const id of ['deriv', 'quotex', 'iqoption', 'pocket']) assert.equal(by(id)?.ready, true, id);
  assert.deepEqual(BROKERS.map((b) => b.id), ['deriv', 'quotex', 'iqoption', 'pocket', 'tradowix', 'binolla']);
  assert.equal(by('binolla')?.ready, false);
});

test('market picker: kinds, names and icons', () => {
  assert.equal(kindOf({ symbol: 'EURUSD_otc' }), 'currency');
  assert.equal(kindOf({ symbol: 'cryETHUSD' }), 'crypto');
  assert.equal(kindOf({ symbol: 'frxXAUUSD' }), 'commodity');
  assert.equal(kindOf({ symbol: 'BOOM1000' }), 'derived');
  assert.deepEqual(splitName({ symbol: 'EURUSD_otc' }), { label: 'EUR/USD', otc: true });
  assert.deepEqual(splitName({ symbol: 'EURUSD' }), { label: 'EUR/USD', otc: false });
  assert.equal(shortName({ symbol: 'R_100', name: 'Volatility 100 Index' }), 'Vol 100');
  assert.deepEqual(iconOf({ symbol: 'EURUSD_otc' }), { kind: 'pair', codes: ['EUR', 'USD'] });
  assert.deepEqual(iconOf({ symbol: 'frxGBPJPY' }), { kind: 'pair', codes: ['GBP', 'JPY'] });
  const eth = iconOf({ symbol: 'ETHUSD_otc' });
  assert.equal(eth.kind === 'coin' && eth.color, '#627eea');
  const r100 = iconOf({ symbol: 'R_100' });
  assert.equal(r100.kind === 'coin' && r100.text, '100');
  const boom = iconOf({ symbol: 'BOOM1000' });
  assert.equal(boom.kind === 'coin' && boom.text, 'B1K');
});

test('chart types and modes', () => {
  assert.deepEqual(CHART_TYPES.map((c) => c.label), ['Candles', 'Hollow candles', 'Bars', 'Heikin Ashi', 'Line', 'Area', 'Baseline']);
  assert.deepEqual(MODES.map((m) => m.label), ['Classic mode', 'Pro mode', 'AI Trader']);
});

test('trade helpers: expiry formatting and limits', async () => {
  const { fmtHMS, fmtShort, clampExpiry } = await import('./assets');
  assert.equal(fmtHMS(245), '00:04:05');
  assert.equal(fmtHMS(14400), '04:00:00');
  assert.equal(fmtShort(3600), '1h');
  assert.equal(fmtShort(245), '4m 5s');
  assert.equal(fmtShort(3), '3s');
  assert.equal(clampExpiry(0), 3);
  assert.equal(clampExpiry(999999), 86400);
});
