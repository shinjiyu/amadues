# Skin frog — authoring chain of thought (from Cursor v3)

Use when you must **write one complete Blender bpy script** that builds a film-ish sitting frog (Skin skeleton → procedural skin → bake → GLB), then run it via Blender bridge `/exec` or MCP `blender_exec`.

**Do not** copy prior `frog_v*.py` / `saved/**` deliverables. Re-derive coordinates and nodes yourself, following this thinking chain.

## Intent (say this to yourself first)

Rebuild from scratch with **skeleton + Skin modifier** so the body is one connected organic volume (sitting pose, folded hind legs, toes, eye turrets) — not stacked UV spheres or disconnected metaballs. Then wart displace, procedural skin, **bake** maps, export GLB, verify with multi-angle stills / H5.

## Why Skin (not boxes / loft-only)

Past sphere / metaball / blind loft attempts looked toy-like or fell apart. A **polyline skeleton with per-vertex radii** + Skin produces naturally connected limbs and torso. Prefer that as the primary mesh strategy.

## Plan before writing code

1. Skeleton joints: spine, legs, toes; assign Skin radii; root at rump; Subsurf + smooth.
2. Eyes: bulging spheres on head; bronze/gold iris; black **horizontal slit** pupils; slightly sunk into turrets.
3. Skin shading: Noise + Voronoi dorsal spots (dark brown/green), cream/yellow belly by normal; bake color / roughness / normal (Cycles); Eevee stills before trusting export.
4. Write the **full** script in one file with `step_*` functions (no giant `main()` that must finish in one 120s call). Call steps separately through the bridge.

## Skeleton coordinates (think in +Y forward, Z up, sit on z≈0)

Map radii as you go — numbers are guidance, not sacred:

- Spine rump → hips → mid → chest → neck → head → snout (midsection widest).
- Eye turrets: short branches off head at roughly x≈±0.25–0.28, high z.
- Hind legs (folded sit): hip out → knee forward-out → ankle back → heel/palm → **4 toes** with slight pads.
- Forelegs: shoulder → elbow → wrist → **4** fanned fingers.

After Skin (+ optional Subsurf): optionally Voxel Remesh (~0.012–0.014) to fuse branch flaps; Voronoi displace for warts along dorsal normals; shade smooth.

Mouth: prefer a **shader** dark crease near the jaw (Z/Y/X masks), not carved geo. Tympanum: distance-to-point brown disc behind each eye in the material.

## Eyes (placement logic)

Scan body verts near head top-sides for max z around x=±0.25; place iris centers slightly inward/down from that peak so they nestle. Iris: bronze, low roughness / coat (wet). Pupils: flattened black ellipsoids on the outer face; track outward; scale wide × thin for a frog slit.

## Materials (object space for lookdev)

- Base: olive ↔ leaf green Noise; optional brown mottling.
- Spots: Voronoi Distance (+ warp); **widen Map Range** until spots cover meaningful dorsum (tight thresholds look like “no spots”). Restrict to upper normals.
- Belly: cream by normal.z (and/or low Z); flank transition.
- Leg bands: Wave bands × |X| far from center.
- Roughness Noise (wetter dorsally); bump = fine Noise + Voronoi; SSS + Coat.
- Name bake hooks `FINAL_COLOR`, `FINAL_ROUGH` (and bump path for NORMAL bake).

## Blender Skin API (bpy)

Adding Skin creates `mesh.skin_vertices[0].data`. Set each vertex `radius = (rx, ry)`; mark rump `use_root = True`; apply with correct active object.

### Hard lesson (must follow even if first CoT skipped remesh)

Skin branches often leave **non-manifold holes**. If you Voxel Remesh an open shell, the **torso can vanish** (only toes/eyes left). After Apply Skin: EDIT `delete_loose` → `remove_doubles` → **`fill_holes(sides=0)`** → `normals_make_consistent`, **then** remesh/smooth.

## Wart displace

Voronoi F1: low distance at cell centers. Negative Displace strength around mid_level 0.5 pops wart centers. Limit with a dorsal vertex group (weight ∝ height × normal.z).

## Bake / export (mandatory for H5)

glTF drops procedural graphs → white mesh in three.js. Cycles EMIT bake color + roughness from FINAL_* hooks; TANGENT NORMAL bake; rewire Principled to images; pack; export selected frog + eyes. Split bake/export into their own `/exec` calls if needed.

## Execution loop

1. Write one `.py` with `step_mesh` / `step_eyes` / `step_material` / `step_stage` / `step_bake` / `step_export` / `step_render`.
2. Health-check bridge (`http://127.0.0.1:11588/health` or MCP `blender_health`).
3. Run mesh → stills (front¾, side, top). If body missing → fix closed remesh and rebuild.
4. Tune materials if spots invisible (Emission-debug Voronoi Distance).
5. Bake → export → optional H5. Do not claim success on Blender-only lookdev without bake if GLB is required.

## Out of scope for this skill

Do not download a stock frog asset. Do not treat this file as permission to paste archived `frog_v3.py` verbatim — re-implement from the chain above.
