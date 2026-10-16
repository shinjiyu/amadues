Target look: cinematic wet amphibian, not toy spheres.

In Blender before GLB export:
- Skin: Principled BSDF with Base Color in deep olive/emerald range, Subsurface Weight > 0 (or Subsurface in older Blender), Roughness roughly 0.25–0.55 with noise-driven variation, clearcoat or low coat for damp patches optional.
- Break up flat color with Noise / Musgrave → ColorRamp mixed into Base Color or Roughness.
- Eyes: separate materials — sclera, dark iris/pupil, higher specular / lower roughness on cornea-like surface.
- shade_smooth; Subdivision Surface level 1–2 on body if needed; apply or keep modifiers exportable.
- Export glTF materials so three.js MeshStandard/Physical materials retain metalness/roughness/emissive maps or factors.

In H5: ACESFilmic tone mapping, Hemisphere + key Directional with soft intensity, cool fill + warm rim; optional RoomEnvironment / PMREM. Screenshot must show highlight streaks on skin and distinct eyes.
