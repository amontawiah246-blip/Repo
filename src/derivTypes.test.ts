import test from 'node:test';
import assert from 'node:assert/strict';
import { DERIV_TYPES, DERIV_PLATFORMS, DEFAULT_DERIV_TYPE, derivTypeOf, tradeBlockReason } from './derivTypes';

test('the ten Deriv trade types from the Deriv screen are all listed, once each', () => {
  assert.deepEqual(DERIV_TYPES.map((t) => t.label), [
    'Rise/Fall', 'Higher/Lower', 'Matches/Differs', 'Even/Odd', 'Accumulators', 'Over/Under', 'Multipliers', 'Touch/No Touch', 'Vanillas', 'Turbos',
  ]);
  assert.equal(new Set(DERIV_TYPES.map((t) => t.id)).size, DERIV_TYPES.length);
  assert.deepEqual(DERIV_PLATFORMS.map((p) => p.label), ['Deriv Trader', 'Deriv Bot', 'SmartTrader']);
});

test('only Rise/Fall can place trades; every other type is blocked on Deriv', () => {
  assert.equal(DEFAULT_DERIV_TYPE, 'risefall');
  assert.equal(tradeBlockReason('deriv', 'risefall'), null);
  for (const t of DERIV_TYPES.filter((x) => x.id !== 'risefall')) {
    assert.match(tradeBlockReason('deriv', t.id) ?? '', /not built yet/);
  }
});

test('the block never touches other brokers, and unknown ids fall back to Rise/Fall', () => {
  assert.equal(tradeBlockReason('pocket', 'turbos'), null);
  assert.equal(tradeBlockReason('quotex', 'accumulators'), null);
  assert.equal(derivTypeOf('nonsense').id, 'risefall');
});
