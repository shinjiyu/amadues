Build a playable H5 3D map game in this working directory, then light and color it, and verify the result with a vision check (via exec — you cannot create new tools).

Asset catalog (follow this guide, do not invent other download URLs first):
https://kuroneko.chat/assets/AGENT.md

Catalog base URL: `https://kuroneko.chat/assets`
(same routes as in AGENT.md: `/api/query`, `/api/fetch`, …)

Your `.agent/rules` and `.agent/skills` were seeded from a prior-run analysis. Follow them (especially: wait for zip completeness before unzip; large downloads in background; resolve Chrome once; prep page/browser/vision while download waits).

Required steps:
1. Read GET {base}/api/query for the kura.query/v1 descriptor.
2. Discover a 3D map / terrain kit (prefer Kenney hexagon or KayKit dungeon / level kits) via discover query.
3. Resolve download with GET {base}/api/fetch?providerId=…&externalId=…. Prefer origin file URLs from the response. Do not invent CDNs.
4. Download the origin zip and unpack the models you need — follow skill `download_unpack` (complete zip before unzip).
5. Create a browser game that loads those models. Prefer a single index.html (or index.html + small local JS). Use three.js from a CDN if needed. The player must be able to move on a hexagonal or tiled 3D map made from the downloaded assets. Keyboard or pointer controls are fine.
6. Do not replace the real models with colored boxes. Placeholder geometry is only allowed briefly while debugging; the finished page must show downloaded GLTF/GLB/OBJ (or equivalent) from the pack.
7. **Lighting and coloring (required):** the finished scene must deliberately light and tint the map — not default flat white. Use multiple lights (for example hemisphere + directional with shadows, or equivalent) and apply visible material / environment coloring (sky, fog, emissive accents, or mesh color tints). The difference must be obvious in a screenshot.
8. **Vision verification (required):** follow skill `shot_and_vision`. Capture a real screenshot (`reports/scene.png`) and write `reports/vision-proof.md` with concrete lighting/color cues from the image. Also leave `reports/design.md` describing the lighting scheme and how you verified it. You only have `exec` (plus any tools already in `.agent/tools.json`); do not expect to invent new tools at runtime.
9. Do not invent API keys. You may use credentials already present in the process environment. Do not write secrets into committed files.
10. Leave `index.html` at the work root so a static server can open the game.

Done means: playable map from Kura assets, intentional lighting/coloring in the page, a real scene screenshot analyzed into `reports/vision-proof.md`, and `reports/design.md` describing lighting + verification.
