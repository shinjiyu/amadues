# 滑稽丸 — Grok chibi CoT report

## Verdict

**Does front34 look like a chibi anime character? YES.**

A stranger would say “cartoon kid / anime mascot,” not “green blob / frog / potato.”

## Why yes

- **Silhouette:** oversized round head dominates; tiny torso + stubby limbs ≈ classic chibi ratio.
- **Face reads anime:** large white sclera discs + blue iris + dark pupil + white specular sparkles; wide open grin with tongue.
- **Mascot cues:** single blue ahoge, cheek blush, coral vest body — humanoid/mascot, not animal.
- **Not a frog:** no amphibian proportions, no green organic body, upright toy-mascot stance.

## Still paths

| View | Path |
|------|------|
| front¾ | `reports/front34.png` |
| side | `reports/side.png` |
| top | `reports/top.png` |

## Deliverables

| Item | Path | Notes |
|------|------|-------|
| Script | `build_chibi_cot.py` | `step_mesh` / `step_face` / `step_material` / `step_stage` / `step_render` / `step_bake` / `step_export` |
| GLB | `chibi.glb` | ~456 884 bytes; FINAL_COLOR baked to maps before export |
| Verts | ~7826 (excl. ground) | Head 762 + Skin body/limbs + face discs |

## Top issues (honest)

1. **Skin reads too pale** in EEVEE stills — peach FINAL_COLOR washes toward off-white under soft fill; needs warmer albedo or less fill.
2. **Brows / blue bars** can misread as a “mustache” under the grin from some angles (hair-colored cylinders near mouth plane).
3. **Primitive toy look** — Skin remesh torso stays blocky; limbs are mitten stubs without fingers (acceptable for comedy mascot, not “fine” anime).

## Pipeline note

Face placed on **−Y** so front¾ camera (also −Y) sees eyes/mouth. First iteration had face on +Y → rear view; fixed before final bake/export.
