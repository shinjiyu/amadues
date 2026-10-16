# Grok CoT skill smoke — REPORT

## Followed CoT skill?
**Yes.** Built from `skin_frog_cot/SKILL.md` only (no `saved/v3|v4`, no prior `frog_v*.py`). Pipeline: polyline skeleton + Skin radii → Subsurf → `delete_loose` / `remove_doubles` / `fill_holes` / normals → Voxel Remesh 0.013 → dorsal Voronoi wart displace → eyes (bronze iris + horizontal slit pupils) → procedural skin with `FINAL_COLOR` / `FINAL_ROUGH` → Cycles bake → GLB → Eevee stills.

## Stats
| Item | Value |
|------|-------|
| Script | `work/build_frog_cot.py` |
| Mesh verts | **17438** |
| Mesh faces | **17440** |
| `frog.glb` | **2,637,136 bytes** (~2.5 MB) |
| Baked maps | `textures/FrogSkin_{Color,Rough,Normal}.png` @ 1024 |
| Stills | `reports/front34.png`, `side.png`, `top.png` |

## Failures & fixes
1. **`__file__` undefined under `exec(open(...))`** — hard-coded `WORK` path.
2. **Blender 5.2: `Mesh.calc_normals_split` removed** — used `v.normal` directly for dorsal wart weights.
3. **MCP timeout on monolithic `step_bake(1024)`** — bake actually finished (images packed + Principled rewired); continued with export. Split bake would be safer next time.
4. **First `front34` was rear¾** — camera was behind (+Y snout); retargeted camera to look toward face.

## Honest quality vs “complete sitting frog with spots”
- **Connected sitting body:** yes — one organic volume, folded hind legs, forelegs, toes as pads (not floating scraps).
- **Recognizable silhouette:** yes in front34 / side / top.
- **Spots:** present (dark dorsal splotches) after widening Map Range; still softer / fewer than a film reference frog.
- **Eyes:** white sclera + bronze iris + slit pupils visible front-on; a bit “googly” / not deeply sunk in turrets; possible Skin turret spike artifacts briefly noted from top.
- **Mouth:** shader dark crease (per skill), readable as a wide gape.
- **Not production-complete:** toe articulation is stubby, iris seating imperfect, wart displace subtle, no H5/three.js verify in this run.

## Skill bullets actually used
- Skeleton + Skin with per-vertex radii; root at rump; Subsurf + remesh.
- After Apply Skin: EDIT `fill_holes(sides=0)` **before** Voxel Remesh (torso-vanish lesson).
- Bake hooks `FINAL_COLOR` / `FINAL_ROUGH`; Cycles EMIT + TANGENT NORMAL; rewire Principled before GLB export.
