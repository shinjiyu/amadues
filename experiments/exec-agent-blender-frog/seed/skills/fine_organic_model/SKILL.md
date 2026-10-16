# Fine organic model (Blender bridge)

Use when the task needs a **detailed animal / creature** (frog, bird, etc.) in GLB + H5 — not toy primitives or a single metaball blob.

Keep each bridge `/exec` under ~120s. Write one script file (e.g. `work/build_*.py`) with **named steps**, then call them one at a time:

`mesh → eyes → material → stage → render_check → bake → export → h5`

Do **not** bake or export until multi-angle stills look acceptable.

---

## 1. Mesh — Skin skeleton (preferred)

Primitives / metaballs alone stay blobby. Prefer **verts + edges + Skin modifier**:

1. Wipe previous hero meshes.
2. Build a polyline skeleton facing **+Y**, Z-up, sitting on z≈0:
   - spine: rump → hips → mid → chest → neck → head → snout
   - eye turrets as short branches off the head
   - hind legs: hip → knee (out/forward) → ankle (back) → heel → palm → 4 toes with slight tip pads
   - forelegs: shoulder → elbow → wrist → 4 fingers
3. Per-vertex Skin radii `(rx, ry)`; mark the rump vertex `use_root = True`.
4. Skin `branch_smoothing ≈ 1.0`, then **apply Skin**.
5. **Close the shell before remesh** (critical — see rule `remesh_closed_mesh`):
   - EDIT: `delete_loose` → `remove_doubles` → `fill_holes(sides=0)` → `normals_make_consistent`
6. Optional Subsurf 1–2, then **Voxel Remesh** (e.g. voxel_size 0.012–0.016) to fuse branch flaps into one manifold.
7. Smooth (factor ~0.5–0.6, 6–12 iters).
8. Dorsal-weighted Voronoi displace for warts (negative strength, vertex group by normal.z / height); light Clouds displace for pores.
9. `shade_smooth` + `uv.smart_project`.
10. Render Eevee stills (front ¾, side, top). If body disappears and only toes/eyes remain → remesh ate an open mesh; fix step 5 and rebuild.

Target: tens of thousands of faces, clear limb topology, no disconnected islands.

---

## 2. Eyes

Separate meshes (not painted on the body):

- Place iris spheres **partly sunk** into eye-turret peaks (not floating on top).
- Horizontal black pupil ellipsoids: track a look vector, scale ≈ (wide, medium, flat), apply transforms.
- Materials: bronze/amber iris (mild metal + coat), near-black pupil, high coat / low roughness.

---

## 3. Procedural skin (lookdev only)

Layer colors in object space; leave named sockets for bake:

- Dorsal olive base + noise brown mottling
- Voronoi dark blotches (widen Distance thresholds until spots are visible — often fail if From Max is too tight; debug by Emission-connecting Voronoi Distance and rendering)
- Optional pale ring around blotches; dorsolateral stripe; flank transition; cream belly by normal.z
- Leg cross-bands (Wave bands × |X| far from center)
- Tympanum discs behind eyes; lip line; paler toe tips
- Roughness noise (wetter dorsally, duller belly); bump from fine Noise + Voronoi
- Principled: SSS weight ~0.1, Coat ~0.3, Specular IOR Level ~0.5

Wire Base Color / Roughness through nodes named `FINAL_COLOR` / `FINAL_ROUGH` so bake can find them.

---

## 4. Stage + lookdev renders

HDR world (e.g. Poly Haven forest), soft key + cool rim, dark ground plane. Camera lens ~70.

Always write stills under `work/reports/` **before** bake. Reject plastic-uniform green with no spots, floating eyes, or white/grey toes.

---

## 5. Bake for glTF (mandatory)

Procedural shader graphs **do not** survive glTF → H5 shows a white / flat mesh. Follow skill `bake_procedural_for_gltf`.

---

## 6. Export + H5

- Parent body + eyes + pupils under an Empty; select them; export GLB with materials + tangents; pack baked images.
- H5: GLTFLoader, ACESFilmic, PMREM / HDR env, shadows.
- Blender +Y forward becomes glTF **−Z**; put the default camera on the **front** of the frog (often `z` negative in three.js if the asset was not rotated).
- Cache-bust the GLB URL (`frog.glb?v=…`) after every re-export.

---

## Acceptance checklist

- [ ] Multi-angle Blender stills show limbs, spots, sunk eyes, wet variation
- [ ] Baked color/rough/normal PNGs exist and re-render matches lookdev
- [ ] `frog.glb` size is megabytes (maps packed), not a tiny untextured shell
- [ ] Browser shot of `index.html` shows textured skin (not white)
- [ ] HUD / vision-proof mentions specular + distinct eyes
