# Screenshot and vision proof (mac Playwright)

Use exec only. Goal: `reports/scene.png` + `reports/vision-proof.md`.

## Preferred path (this machine)

1. Serve: `(cd "$PWD" && python3 -m http.server 8765 >/tmp/frog-http.log 2>&1 &)` then `curl -sI http://127.0.0.1:8765/ | head -1`.
2. Resolve Chromium **once**:
   - Look under `$HOME/Library/Caches/ms-playwright/chromium-*/chrome-mac*/` for `Google Chrome for Testing` or `Chromium`.
   - Else: `npm i playwright@1.49.0 --prefix /tmp/pw` and `node /tmp/pw/node_modules/playwright/cli.js install chromium` **as their own short execs**; then require from `/tmp/pw/node_modules/playwright`.
3. Write `/tmp/shot.js` that: launches chromium headless, viewport 1400×900, `goto` waitUntil `networkidle`, wait ~4s for GLB, screenshot to **absolute** `.../work/reports/scene.png`, exit.
4. Run `node /tmp/shot.js` — keep this exec under ~60s. Verify `file reports/scene.png`.
5. PIL/node sample sky / frog-green / ground; write concrete numbers into `reports/vision-proof.md`. Also `reports/design.md`.

## Do not

- Safari `webdriver.Safari()` as first choice (often no usable shot / wrong cwd).
- `which google-chrome` as the only strategy.
- Bundle install+screenshot in one 120s+ exec.
