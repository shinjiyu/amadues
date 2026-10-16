# game_eval_adapter

Satisfy the game-eval Runtime ABI before declaring completion.

## Checklist

1. Read `instruction.md` evaluation contract section.
2. Implement Adapter on the playable entry the gate loads (usually web build entry).
3. Ensure:
   - `window.gameReady === true` when the game accepts input
   - `window.getGameState()` returns a JSON-serializable snapshot of true business state
   - `window.injectGameState(partial)` applies legal preconditions only
4. Write / update `data.md` describing state fields.
5. Write / update `state_injection_api.md` documenting allowed inject keys.
6. If `check-evaluation-contract.mjs` exists, run it with node and fix failures.
7. Prefer a quick local preview/publish to confirm the page loads before stopping.
