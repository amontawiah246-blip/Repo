import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, ChildProcess } from 'child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';
import { registerAutoRoutes } from './autoServer';
import { registerSignalRoutes } from './signalServer';
import { registerScanRoutes } from './scanServer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const BRIDGE_PORT = 8765;

let bridgeProc: ChildProcess | null = null;

function startBridge() {
  console.log(`[Server] Starting internal Pocket Option bridge on 127.0.0.1:${BRIDGE_PORT}...`);
  const env = {
    ...process.env,
    POCKET_SSID: process.env.POCKET_SSID || '',
    IQ_EMAIL: process.env.IQ_EMAIL || 'yawkwasi224@gmail.com',
    IQ_PASSWORD: process.env.IQ_PASSWORD || 'khemical2$',
    QUOTEX_SSID: process.env.QUOTEX_SSID || 'QYezx7eGMKAnf3JSOzoPqU0YJER6vpsFHqNi0D4w',
    DERIV_TOKEN: process.env.DERIV_TOKEN || 'pat_12430e9f3555e6dd3a2ad5bb86555b0a530667adbd0b8efd1f97b3abdcdaf106',
    DERIV_APP_ID: process.env.DERIV_APP_ID || '34QcI4Rf8S5tCkL6PMOcI',
  };

  bridgeProc = spawn('python3', ['-m', 'uvicorn', 'bridge.server:app', '--host', '127.0.0.1', '--port', String(BRIDGE_PORT), '--log-level', 'warning'], {
    env,
    cwd: __dirname,
  });

  bridgeProc.stdout?.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) console.log(`[Bridge] ${msg}`);
  });

  bridgeProc.stderr?.on('data', (data) => {
    const msg = data.toString().trim();
    if (!msg) return;
    if (msg.includes('ERROR') || msg.includes('Traceback') || msg.includes('Exception:')) {
      console.error(`[Bridge Error] ${msg}`);
    } else {
      console.log(`[Bridge] ${msg}`);
    }
  });

  bridgeProc.on('exit', (code, sig) => {
    console.log(`[Bridge] Exited with code ${code}, signal ${sig}. Restarting in 3s...`);
    setTimeout(startBridge, 3000);
  });
}

async function main() {
  if (!process.env.NO_BRIDGE) startBridge();   // NO_BRIDGE=1: the bridge runs elsewhere (or a test stub)

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  registerAutoRoutes(app, BRIDGE_PORT); // AI Trading autopilot (runs here so it survives a locked phone)
  registerSignalRoutes(app, BRIDGE_PORT);
  registerScanRoutes(app, BRIDGE_PORT);

  // Proxy status
  app.get('/api/status', async (req, res) => {
    try {
      const query = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
      const response = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/api/status${query}`);
      if (response.ok) {
        const data = await response.json();
        return res.json(data);
      }
    } catch {
      // Bridge still warming up
    }
    res.json({
      ready: false,
      error: 'Connecting to the live bridge...',
      balance: null,
      demo: true,
      assets: 0,
    });
  });

  // Proxy assets list
  app.get('/api/assets', async (req, res) => {
    try {
      const query = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
      const response = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/api/assets${query}`);
      if (response.ok) {
        const data = await response.json();
        return res.json(data);
      }
    } catch {
      // Return empty array while loading
    }
    res.json([]);
  });

  // Proxy SSID update
  app.post('/api/set-ssid', async (req, res) => {
    try {
      const response = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/api/set-ssid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
      });
      const data = await response.json();
      return res.json(data);
    } catch (e) {
      res.status(500).json({ status: 'error', msg: String(e) });
    }
  });

  // Proxy broker login (Quotex email/password)
  app.post('/api/set-credentials', async (req, res) => {
    try {
      const response = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/api/set-credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
      });
      const data = await response.json();
      return res.json(data);
    } catch (e) {
      res.status(500).json({ status: 'error', msg: String(e) });
    }
  });

  // Demo <-> real account switch
  app.post('/api/account', async (req, res) => {
    try {
      const response = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/api/account`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body), signal: AbortSignal.timeout(30000),
      });
      res.json(await response.json());
    } catch (e) {
      res.status(500).json({ status: 'error', msg: String(e) });
    }
  });

  // Proxy manual trades (buy / sell)
  app.post('/api/trade', async (req, res) => {
    try {
      const response = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/api/trade`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
      });
      const data = await response.json();
      return res.json(data);
    } catch (e) {
      res.status(500).json({ status: 'error', msg: String(e) });
    }
  });

  // Proxy trade results (polling result of placed trade)
  app.get('/api/trade-result', async (req, res) => {
    try {
      const query = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
      const response = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/api/trade-result${query}`);
      const data = await response.json();
      return res.json(data);
    } catch (e) {
      res.status(500).json({ status: 'error', msg: String(e) });
    }
  });

  // Proxy synthetic candles for multi-agent charts
  app.get('/api/deriv/synthetic-candles', async (req, res) => {
    try {
      const query = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
      const response = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/api/deriv/synthetic-candles${query}`);
      const data = await response.json();
      return res.json(data);
    } catch (e) {
      res.status(500).json({ status: 'error', msg: String(e) });
    }
  });


  // Proxy diag endpoint
  app.get('/api/diag', async (req, res) => {
    try {
      const query = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
      const response = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/api/diag${query}`);
      if (response.ok) {
        const data = await response.json();
        return res.json(data);
      }
      res.status(response.status).json({ error: 'Diag endpoint returned non-200' });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  const server = http.createServer(app);

  // WebSocket Server for /ws proxy
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);
    if (url.pathname === '/ws') {
      wss.handleUpgrade(request, socket, head, (clientWs) => {
        wss.emit('connection', clientWs, request);
      });
    }
  });

  wss.on('connection', (clientWs: WebSocket, request: http.IncomingMessage) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);
    const upstreamUrl = `ws://127.0.0.1:${BRIDGE_PORT}/ws${url.search}`;

    let upstreamWs: WebSocket | null = null;
    let isClientClosed = false;

    try {
      upstreamWs = new WebSocket(upstreamUrl);

      upstreamWs.on('open', () => {
        // Forward buffered messages if any
      });

      upstreamWs.on('message', (data, isBinary) => {
        if (!isClientClosed && clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(data, { binary: isBinary });
        }
      });

      upstreamWs.on('error', (err) => {
        if (!isClientClosed && clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({ type: 'info', msg: `Bridge connecting: ${err.message}` }));
        }
      });

      upstreamWs.on('close', () => {
        if (!isClientClosed && clientWs.readyState === WebSocket.OPEN) {
          clientWs.close();
        }
      });

      clientWs.on('message', (data, isBinary) => {
        if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN) {
          upstreamWs.send(data, { binary: isBinary });
        }
      });

      clientWs.on('close', () => {
        isClientClosed = true;
        if (upstreamWs) {
          upstreamWs.close();
        }
      });

      clientWs.on('error', () => {
        isClientClosed = true;
        if (upstreamWs) {
          upstreamWs.close();
        }
      });
    } catch {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: 'error', msg: 'Unable to connect to Pocket Option bridge' }));
      }
    }
  });

  // Mount Vite middlewares in development
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] Full-stack QuantX server running at http://0.0.0.0:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[Server Fatal]', err);
  process.exit(1);
});
