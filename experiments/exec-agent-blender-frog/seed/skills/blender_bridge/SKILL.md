# Blender bridge via curl

Default base: `http://127.0.0.1:11588` (or `$BLENDER_MCP_BRIDGE`).

1. `curl -sS "$BRIDGE/health"` — require `"ok": true`.
2. For non-trivial builds: write a `.py` under the work dir with **step functions**, then POST `/exec` with code that `exec(open(path).read(), ns)` and call **one** `ns["step_…"]()` (rule `split_blender_steps`). Prefer data API; last expression / `result` = JSON.
3. Fine creatures: follow skill `fine_organic_model` (Skin skeleton → close mesh → remesh → lookdev → bake → export).
4. Export with **absolute** path under the work dir after bake:
   `bpy.ops.export_scene.gltf(filepath="<abs>/frog.glb", export_format="GLB", use_selection=True, export_materials="EXPORT")`
5. `ls -l frog.glb` — expect multi-MB if maps packed.
6. Optional: POST `$BRIDGE/viewport`; H5 acceptance still needs a browser shot of `index.html` (skill `shot_and_vision`).

Timeouts: keep each `/exec` under ~120s; never mesh+bake+export in one shot.
