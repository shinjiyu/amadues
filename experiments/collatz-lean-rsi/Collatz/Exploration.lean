import Collatz.Conjecture

/-!
Exploration scratchpad: lemmas / small facts that MUST remain compilable.
Formal RSI assault may APPEND concrete reachability facts; gate = `lake build`.
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

theorem step_2 : Collatz.step 2 = 1 := by decide
theorem reaches_2 : Collatz.ReachesOne 2 := ⟨1, by decide⟩
theorem reaches_4 : Collatz.ReachesOne 4 := ⟨2, by decide⟩

/-- assault append --/
theorem step_3 : Collatz.step 3 = 10 := by decide
theorem reaches_8 : Collatz.ReachesOne 8 := ⟨3, by decide⟩
theorem reaches_16 : Collatz.ReachesOne 16 := ⟨4, by decide⟩

/-- assault append --/
theorem step_5 : Collatz.step 5 = 16 := by decide
theorem reaches_5 : Collatz.ReachesOne 5 := ⟨5, by decide⟩
theorem reaches_32 : Collatz.ReachesOne 32 := ⟨5, by decide⟩

/-- assault append --/
theorem step_6 : Collatz.step 6 = 3 := by decide
theorem reaches_6 : Collatz.ReachesOne 6 := ⟨8, by decide⟩
theorem reaches_10 : Collatz.ReachesOne 10 := ⟨6, by decide⟩

end Collatz.Exploration
