# Parallel prep while download waits

When a background download is in progress, do not busy-loop on unzip. In the same waiting window you may:

1. `mkdir -p models reports`
2. Draft `index.html` skeleton (three.js CDN, lights placeholders)
3. Resolve Chromium path once into `reports/chrome.path`
4. Write the single vision analyzer script you will reuse later

Only after the zip is complete: unpack, copy needed GLBs, finish the page, screenshot, vision proof.
