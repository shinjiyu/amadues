Blender bridge `/exec` shares the shell ~120s budget. For fine models, never put mesh+material+bake+export+render in one call.

Write a single `.py` with step functions (`step_mesh`, `step_eyes`, `step_material`, `step_stage`, `step_bake`, `step_export`, `step_render`) and invoke **one step per** `bridge_exec` / curl POST. Bake (2048) and multi-render may each need their own call.
