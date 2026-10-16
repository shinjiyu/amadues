Build a **fine organic frog** in Blender from scratch, bake PBR maps, export `frog.glb`, present it in cinematic H5, and vision-verify via exec. You cannot create tools. Follow seeded skills/rules — especially `fine_organic_model`, `bake_procedural_for_gltf`, `lookdev_render_loop`, `blender_bridge`, `shot_and_vision`.

This is **not** a toy-primitive frog and **not** “reuse a previous script from disk.” Your working directory starts empty aside from `.agent/` seed. Build the mesh and materials yourself through the Blender bridge.

## Blender bridge (required)

A Blender window must already be open with **blender-meta-mcp** on:

```text
http://127.0.0.1:11588
```

Talk to it **only through shell `exec`** (curl) or seeded `bridge_health` / `bridge_exec`. Do not assume Cursor MCP tool names exist here.

### Endpoints

1. **Health** — `curl -sS http://127.0.0.1:11588/health` → `"ok": true`. If refused: stop; do not invent headless `blender --background`.

2. **Exec bpy** — `POST /exec` with JSON `{"code":"...","undo":true}`. Prefer writing a step-script under `$PWD` (e.g. `build_frog.py` with `step_mesh` / `step_eyes` / `step_material` / `step_stage` / `step_bake` / `step_export` / `step_render`) and calling **one step per** `/exec` (rule `split_blender_steps`, ~120s budget).

3. Optional `POST /viewport`. Export absolute paths under this cwd: `frog.glb` required.

## Required pipeline (seed skills)

Follow `fine_organic_model` in order:

1. **Health** ok.
2. **Mesh — Skin skeleton** (not a single metaball / stacked UV spheres as the final body):
   - Polyline spine (+Y forward, Z up), eye turrets, folded hind legs with toes, forelegs with fingers; per-vertex Skin radii; root at rump.
   - Apply Skin → **close shell** (`fill_holes` etc., rule `remesh_closed_mesh`) → Voxel Remesh → smooth → dorsal wart displace → UV smart project.
   - If a render shows only toes/eyes and no torso: remesh ate an open mesh — fix and rebuild.
3. **Eyes** — separate sunk iris + horizontal pupil; readable wet specular.
4. **Procedural skin lookdev** — olive mottling, Voronoi blotches (Emission-debug if invisible), belly, leg bands, roughness/bump variation, SSS + coat. Name bake hooks `FINAL_COLOR` / `FINAL_ROUGH`.
5. **Lookdev stills** before bake — `reports/` front¾ + side + top at minimum (`lookdev_render_loop`). Reject plastic-flat green / floating eyes / missing spots.
6. **Bake for glTF** (mandatory, rule `gltf_requires_bake`) — Cycles EMIT color + roughness, NORMAL map; rewire Principled to images; pack. Skipping bake → white frog in H5.
7. Export `frog.glb` (expect multi-MB with maps). Parent body+eyes; materials exported.
8. **H5** — `index.html` + three.js GLTFLoader, ACESFilmic, key/fill/rim or HDR/IBL, shadows. Camera on the **front** of the asset (Blender +Y → glTF −Z). Cache-bust `frog.glb?v=…`.
9. **Vision** — `shot_and_vision`: `reports/scene.png` + `reports/vision-proof.md` must cite specular, skin variation/spots, eye wetness, cinematic light with concrete cues. Also `reports/design.md`.

## Hard bans

- Do **not** download a pre-made frog GLB / OBJ as the hero mesh (rule `no_download_frog`).
- Do **not** copy `../saved/**`, prior `frog_v*.py`, or any archived build into this run as the deliverable. Fresh bpy construction only.
- Do not invent API keys. Do not append shell junk into `index.html`.

Done means: Skin-based fine frog, **baked** maps in GLB, cinematic H5, vision proof that describes material quality — not “there is a green blob.”
