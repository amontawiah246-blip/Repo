from curl_cffi.requests import Session
import json, time, sys

SESSION = 'QYezx7eGMKAnf3JSOzoPqU0YJER6vpsFHqNi0D4w'
url = 'wss://ws2.quotex.com/socket.io/?EIO=4&transport=websocket'

s = Session(impersonate='chrome124')
headers = {
    'Origin': 'https://quotex.com',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
}
ws = s.ws_connect(url, headers=headers)
print("Connected!", flush=True)

h, _ = ws.recv()
print("Handshake:", h, flush=True)

ws.send('40')
c, _ = ws.recv()
print("Namespace ack:", c, flush=True)

auth = '42["authorization",{"session":"' + SESSION + '","isDemo":1,"tournamentId":0}]'
ws.send(auth)
print("Auth sent!", flush=True)

for i in range(15):
    try:
        data, typ = ws.recv()
        if data == b'2':
            ws.send('3')
            print("PONG", flush=True)
            continue
        text = data.decode('utf-8', 'ignore') if isinstance(data, bytes) else str(data)
        if text.startswith('\x04[['):
            print(f"[{i}] Instruments binary: {len(text)} bytes", flush=True)
            # Parse assets
            try:
                assets = json.loads(text[1:])
                print(f"[{i}] Found {len(assets)} assets. Sample: {assets[0][:4]}", flush=True)
            except Exception as e:
                print("Parse err:", e, flush=True)
            # After receiving instruments, request chart/candles or depth
            ws.send('42["depth/follow","EURUSD_otc"]')
            print("Sent depth/follow EURUSD_otc", flush=True)
        else:
            print(f"[{i}] typ={typ}: {text[:150]!r}", flush=True)
    except Exception as e:
        print("Recv err:", e, flush=True)
        break
