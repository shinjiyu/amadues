# Lookdev render QA loop

Use while building / refining a Blender hero mesh before bake/export.

## Still set (minimum)

After mesh and after materials, render at least:

| name | purpose |
|------|---------|
| `*_front34` | silhouette, eyes, front toes |
| `*_side` | limb fold, belly transition |
| `*_top` | dorsal spots, wart density |
| `*_head` (optional) | pupil orientation, snout |

Save under `work/reports/` with absolute paths. Prefer Eevee for speed; Cycles only if needed for SSS check.

## Reject and fix

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Only toes / eyes / leaf scraps | Voxel remesh on open Skin mesh | fill_holes + remesh; rebuild |
| Front still is two floating eyes + green shards | Same remesh failure — **do not bake** | Rebuild mesh; require torso bbox ≥ ~40% of frame height before bake |
| Uniform lime plastic, no spots | Blotch Map Range too tight / wrong space | Emission-debug Voronoi Distance |
| Floating marble eyes | Eye centers above turret | Sink spheres; larger pupil track |
| White / grey toes in material | Color layers ignore low-Z limbs | toe_fac / \|X\| legness mixes |
| White frog in H5 only | No bake | skill `bake_procedural_for_gltf` |
| H5 shows rear only | Blender +Y → glTF −Z | Move three.js camera / rotate root |
| Vision-proof claims full anatomy but shot is scraps | Proof written without looking | Re-open `reports/scene.png`; rewrite proof from pixels |

## Rule of work

One visual rejection → change **one** subsystem (mesh **or** material **or** camera), re-render the same still names, then continue. Do not bake until front34 + top pass a quick glance.
