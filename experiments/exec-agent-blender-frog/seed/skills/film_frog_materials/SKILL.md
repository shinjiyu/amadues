# Film-real frog materials

Prefer the full pipeline in skill `fine_organic_model`. This note is the **material-only** short list.

## Blender lookdev

- Principled skin: deep olive/emerald, SSS weight > 0, roughness ~0.2–0.5 with noise, Coat for damp patches.
- Break flat color: Noise mottling + Voronoi blotches (verify blotches with Emission debug if invisible) + belly by normal.z + leg bands.
- Eyes: separate iris + horizontal pupil; sunk into head; high coat / low roughness.
- `shade_smooth`; dorsal wart displace after a **closed** remesh (rule `remesh_closed_mesh`).

## Export

- **Bake** color / roughness / normal before GLB (rule `gltf_requires_bake`, skill `bake_procedural_for_gltf`).
- Export absolute `frog.glb` with packed images.

## H5

- ACESFilmic + HDR / RoomEnvironment PMREM; key + cool fill + rim.
- Camera on the **front** of the asset (Blender +Y → glTF −Z).
- Proof: specular streaks, dorsal spots, distinct eyes — not a white mesh.
