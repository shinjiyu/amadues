# kurenai_cocos

Use kurenai as the primary Cocos CLI host for this Candidate.

## Loop

1. `kurenai context --project "$PWD"` — understand scenes, assets, scripts.
2. `kurenai host start --project "$PWD"` before editor-like ops that need the host.
3. Edit TypeScript / assets under the project with normal shell editors (`cat`, `tee`, patches).
4. After meaningful changes: `kurenai publish --platform web-mobile --project "$PWD"` (or `cocos build` if publish fails).
5. `kurenai logs --errors --project "$PWD"` when something breaks; fix and republish.
6. `kurenai host stop --project "$PWD"` when finished or before long idle.

## Notes

- kurenai prints JSON; check `ok` fields.
- Do not assume PinK UI is open.
- Keep builds under the Candidate directory.
