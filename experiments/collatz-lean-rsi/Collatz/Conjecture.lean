/-!
# Collatz (3n+1) conjecture — open statement for Harness-RSI pilot.

Craft gate = `lake build` (file typechecks). Truth of the conjecture is NOT the gate.
-/

namespace Collatz

/-- One Collatz step. -/
def step (n : Nat) : Nat :=
  if n % 2 = 0 then n / 2 else 3 * n + 1

/-- Iterate `step` exactly `k` times. -/
def iterate (k n : Nat) : Nat :=
  match k with
  | 0 => n
  | k' + 1 => step (iterate k' n)

/-- Open conjecture: every positive `n` eventually reaches 1. -/
def ReachesOne (n : Nat) : Prop :=
  ∃ k, iterate k n = 1

/-- The Collatz conjecture (unproven). Left as `sorry` on purpose. -/
theorem conjecture : ∀ n : Nat, n > 0 → ReachesOne n := by
  sorry

end Collatz
