# Grok CoT skill smoke — Skin frog

You are testing whether the skill `skin_frog_cot` is enough to reproduce a v3-like frog.

## Allowed
- Read ONLY: `experiments/exec-agent-blender-frog/grok-cot-test/.agent/skills/skin_frog_cot/SKILL.md`
- Write scripts under `experiments/exec-agent-blender-frog/grok-cot-test/work/`
- Use Blender MCP (`blender_health`, `blender_exec`, `blender_viewport`) OR curl `http://127.0.0.1:11588`

## Forbidden
- Reading `saved/v3/**`, `saved/v4/**`, `frog_v3.py`, `frog_v4.py`, or any prior build scripts
- Downloading a pre-made frog GLB/OBJ

## Deliverables (in grok-cot-test/work/)
1. One bpy build script with step_* (written by you)
2. `frog.glb` (multi-MB if baked maps packed)
3. At least `reports/front34.png` (and ideally side/top)
4. Short `REPORT.md`: did you follow the CoT skill? what failed? final vert/face counts and glb bytes

Bridge is already up on this machine.
