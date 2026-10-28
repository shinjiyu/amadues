# Task: Playable Tetris on Enji (Cocos Creator 3.8 agent host)

Working directory is an **already initialized Enji project**. Host may already be running.

## Requirements
- Classic Tetris: 10×20, 7 tetrominoes, rotate, gravity, soft/hard drop, line clear, score, game over + restart
- Keyboard controls
- Follow project `AGENTS.md` exactly (MainView.bind, no hand-written .meta uuids, prefab rules)
- Use `enji` CLI: `host status|logs|import|check` as needed
- Do **not** stop the host when done

## Done when
Preview shows a playable Tetris with no compile errors (`enji logs --errors` clean enough to play).
