# Quotex Socket.IO Quick Reference

## Authentication Message Format

```
42["authorization",{"session":"<SSID>","isDemo":1,"tournamentId":0}]
```

### Python Code
```python
await api.login_with_ssid(
    ssid="dJzhzzKSR6N4Lr5OvTFuvcGLCfyDjtdbNDMScXcH",
    is_demo=True  # True = demo (1), False = real (0)
)
```

## Socket.IO Message Types

| Code | Name | Format | Purpose |
|------|------|--------|---------|
| `0` | Handshake | `0{"sid":"..."}` | Initial connection |
| `2` | Ping | `2` | Keep-alive |
| `3` | Pong | `3` | Keep-alive response |
| `40` | Connect | `40` | Namespace connection |
| `42` | Event | `42["event",{data}]` | Application messages |

## Common Events

### Authorization
```javascript
// Request
42["authorization",{"session":"SSID","isDemo":1,"tournamentId":0}]

// Response
42["authorization",{"isSuccessful":true,"userId":"12345",...}]
```

### Place Trade
```javascript
42["place_trade",{"asset":"EURUSD","direction":"call","amount":100,"expiry":60}]
```

### Subscribe Candles
```javascript
42["subscribe_candles",{"asset":"EURUSD","timeframe":60}]
```

### Candle Update (pushed)
```javascript
42["candle",{"asset":"EURUSD","open":1.0850,"high":1.0855,"low":1.0848,"close":1.0852}]
```

### Trade Result (pushed)
```javascript
42["trade_result",{"orderId":"12345","result":"win","profit":85.0}]
```

## Connection Flow

```
1. Connect → wss://quotex.io/socket.io/?EIO=4&transport=websocket
2. Receive ← 0{"sid":"..."}
3. Send    → 40
4. Send    → 42["authorization",{...}]
5. Receive ← 42["authorization",{...}]
6. Ready to trade!
```

## Getting Your SSID

1. Log into quotex.io in browser
2. Open DevTools (F12)
3. Application → Cookies → quotex.io
4. Find "ssid" or "session" cookie
5. Copy the value

## Quick Test

```python
import asyncio
from QuotexAPI import QuotexAPI

async def test():
    api = QuotexAPI()
    await api.connect()
    await api.login_with_ssid(ssid="YOUR_SSID", is_demo=True)
    balance = await api.get_balance()
    print(f"Balance: ${balance.amount}")
    await api.disconnect()

asyncio.run(test())
```

## Important Notes

- ✅ All messages use Socket.IO format: `42["event", data]`
- ✅ SSID format: `{"session":"...","isDemo":1,"tournamentId":0}`
- ✅ isDemo: 1 = demo account, 0 = real account
- ✅ Responses are also events (not direct replies)
- ✅ Subscribe to event before sending request
