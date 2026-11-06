Upload this project AS IS. Tell Gemini / AI Studio: replace the project files with the ones in this zip exactly; do not redesign, rewrite or improve any file.

NEW IN THIS VERSION
- bridge/engines/  your three engines + combine.py (sweep = boss, 2+ indicator strategies confirm, candle pattern counts only if indicators agree)
- signalServer.ts  AI check (Gemini approves or vetoes each setup) and /api/signal. Needs GEMINI_API_KEY in the server environment.
- autoServer.ts    AI Trading runs on the server (keeps going with the phone locked). Works on Pocket, Quotex, IQ Option, Deriv (Rise/Fall).
- Demo / Real switch on Home and in the AI Trading window.
- The chart is untouched: everything runs in the background.

Tests:  npx tsx --test src/*.test.ts      and      cd bridge && python3 -m unittest test_engines
