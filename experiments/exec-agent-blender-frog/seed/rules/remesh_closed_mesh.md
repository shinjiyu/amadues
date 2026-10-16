Before Voxel Remesh / boolean / volume ops on a Skin-modifier body:

1. Apply Skin.
2. EDIT mode: delete loose → remove doubles → **fill_holes(sides=0)** → normals_make_consistent.
3. Only then remesh.

Skin output often has non-manifold edges / open flaps at branches. Remeshing an open shell can **delete the torso** and leave only extremities (toes, eye stubs). If a render shows floating eyes + feet with no body, assume this failure and rebuild from Skin apply + fill_holes.
