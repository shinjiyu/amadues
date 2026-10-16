Any Blender material that uses procedural nodes (Noise, Voronoi, Wave, Mix ramps, Bump graphs) **must** be Cycles-baked to image textures (color + roughness at minimum; normal recommended) and rewired onto Principled **before** `export_scene.gltf`.

Skipping bake causes a white or flat mesh in three.js/H5 even when the Blender viewport looks correct. Follow skill `bake_procedural_for_gltf`. After re-export, bump the GLB query string (`?v=`) so the browser does not keep a white cache.
