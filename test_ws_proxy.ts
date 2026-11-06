import { WebSocket } from 'ws';

console.log("Connecting to ws://localhost:3000/ws?asset=EURUSD_otc&tf=60...");
const ws = new WebSocket('ws://localhost:3000/ws?asset=EURUSD_otc&tf=60');

ws.on('open', () => {
  console.log('[Connected to local ws proxy!]');
});

ws.on('message', (data) => {
  console.log('[Proxy Message]:', data.toString().substring(0, 150));
});

ws.on('error', (err) => {
  console.error('[Proxy Error]:', err.message);
});

ws.on('close', (code, reason) => {
  console.log('[Proxy Closed]:', code, reason.toString());
});

setTimeout(() => {
  ws.close();
  process.exit(0);
}, 6000);
