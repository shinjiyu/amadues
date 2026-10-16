# Funny chibi anime character — authoring chain of thought

Use when you must **write one complete Blender bpy script** that builds a **滑稽动漫 / comedy-chibi** character (readable silhouette, big head, stubby body), then bake for GLB via Blender bridge `/exec` or MCP `blender_exec`.

**Do not** build a frog, toad, or animal. **Do not** copy `frog_*.py` / `saved/**` / prior grok frog scripts.

## Intent

One-shot author a script for a **goofy anime chibi**, not a realistic creature:

- **Name / vibe:** 「滑稽丸」— round oversized head, tiny pear body, stubby limbs, huge shiny eyes, silly open grin, optional ahoge (single spring hair).
- Silhouette must read as **anime mascot** from front¾ in under a second (big head : small body ≈ 1 : 0.45).

## Why this mesh strategy

For comedy chibi, prefer **Skin skeleton** (or loft tubes) for limbs + a **large UV sphere / Skin head bulb** — not organic amphibian proportions. Keep topology simple; expressiveness comes from **proportions + face**, not wart displace.

## Plan before writing code

1. Skeleton / volumes: giant head sphere (or thick Skin head), short spine, stubby arms/legs with mitten hands / blob feet.
2. Face (separate meshes or painted via material on head): two huge iris discs + pupils + white sclera/highlights; open mouth as a dark gap mesh or shader mask; optional blush discs.
3. Materials: flat-ish toon PBR — saturated skin, simple hair color, low roughness; bake color (+ rough/normal if used).
4. Full script with `step_*`; split `/exec` under ~120s.

## Proportions (+Y forward, Z up, stand/sit on z≈0)

Guidance numbers — re-derive as needed:

- Head center ~ (0, 0.15, 0.55), radius ~0.28–0.32 (dominant volume).
- Body: short Skin chain under head, max radius ~0.14, height ~0.25.
- Arms: shoulder near head–body join, length short, end in mitten (3 stub toes max or a pad).
- Legs: very short; feet as fat discs so it stands.
- Ahoge: thin Skin or two-vert curve from crown, springy S-shape.

After Skin: **fill_holes → remesh optional** (same torso-vanish rule as organic builds). Subsurf lightly; shade smooth.

## Face (must sell “anime”)

- Eyes: large spheres or discs on front of head (±x), iris bright (coral / sky / gold), big pupils, **white specular sparkles** as tiny spheres.
- Mouth: wide open “D” or “ω” silhouette — either a boolean-ish dark mesh inset or a high-contrast shader blob on the head front.
- Optional: oval blush patches on cheeks (pink emission-ish low strength or base-color discs).

If the still looks like an amorphous green blob with dots, **you failed** — push head size and eye size up.

## Materials

- Skin: warm peach / cream Principled; slight SSS.
- Hair/ahoge: saturated accent (blue/pink/black).
- Body clothes optional: simple solid vest color on torso via material slots or vertex paint / object-Z mask.
- Hooks `FINAL_COLOR` / `FINAL_ROUGH` for bake. **Bake before GLB** (glTF drops node graphs).

## Execution loop

1. Write `build_chibi_cot.py` with step_mesh / step_face / step_material / step_stage / step_bake / step_export / step_render.
2. Bridge health → mesh → front34 / side / top stills.
3. Reject stills that are not obviously a chibi anime character; enlarge head/eyes and rebuild.
4. Bake → export `chibi.glb` (or `frog.glb` only if instruction forces that name — prefer `chibi.glb`).

## Forbidden

- Frogs, toads, lizards, “organic creature” briefs.
- Copying Skin frog coordinate tables from other skills as the hero mesh.
- Stock downloaded anime GLB.
