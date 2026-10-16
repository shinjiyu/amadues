# Screenshot and vision proof

You cannot create_tool. Use exec for both capture and analysis.

1. Serve `index.html` locally (python -m http.server or similar).
2. Resolve Chrome once (ms-playwright cache or puppeteer); save path to `reports/chrome.path`.
3. Capture `reports/scene.png` with that executable.
4. Analyze the PNG with a short node/python script (pngjs / PIL): sample sky / terrain tint / shadow cues.
5. Write concrete lighting/color observations to `reports/vision-proof.md` (not generic filler).
6. Keep one analyzer script under `tools/vision.js` or `.agent/see_grid.py` — reuse it; do not invent many near-duplicate names.
