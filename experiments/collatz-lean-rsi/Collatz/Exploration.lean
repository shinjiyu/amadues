import Collatz.Conjecture

/-!
Exploration scratchpad: lemmas / small facts that MUST remain compilable.
Harness-RSI may revise skills & scripts that guide work here; `lake build` gates upgrades.
-/

namespace Collatz.Exploration

theorem step_even (k : Nat) : Collatz.step (2 * k) = k := by
  simp [Collatz.step]

theorem step_one : Collatz.step 1 = 4 := by
  simp [Collatz.step]

theorem iterate_zero (n : Nat) : Collatz.iterate 0 n = n := rfl

/-- Tiny verified seed: 1 reaches 1 in 0 steps. -/
theorem one_reaches_one : Collatz.ReachesOne 1 := by
  refine ⟨0, ?_⟩
  simp [Collatz.iterate]

end Collatz.Exploration
