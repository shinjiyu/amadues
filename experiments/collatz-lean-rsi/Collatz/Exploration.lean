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

/-- assault append --/
theorem step_7 : Collatz.step 7 = 22 := by decide
theorem reaches_3 : Collatz.ReachesOne 3 := ⟨7, by decide⟩
theorem reaches_20 : Collatz.ReachesOne 20 := ⟨7, by decide⟩

/-- assault append --/
theorem step_9 : Collatz.step 9 = 28 := by decide

theorem reaches_9 : Collatz.ReachesOne 9 := ⟨19, by decide⟩

theorem reaches_28 : Collatz.ReachesOne 28 := ⟨18, by decide⟩

/-- assault append --/
theorem step_11 : Collatz.step 11 = 34 := by decide

theorem reaches_40 : Collatz.ReachesOne 40 := ⟨8, by decide⟩

theorem reaches_21 : Collatz.ReachesOne 21 := ⟨7, by decide⟩

/-- assault append --/
theorem step_12 : Collatz.step 12 = 6 := by decide
theorem step_13 : Collatz.step 13 = 40 := by decide
theorem reaches_13 : Collatz.ReachesOne 13 := ⟨9, by decide⟩

/-- assault append --/
theorem step_17 : Collatz.step 17 = 52 := by decide
theorem reaches_17 : Collatz.ReachesOne 17 := ⟨12, by decide⟩
theorem reaches_52 : Collatz.ReachesOne 52 := ⟨11, by decide⟩

/-- assault append --/
theorem step_19 : Collatz.step 19 = 58 := by decide
theorem reaches_19 : Collatz.ReachesOne 19 := ⟨20, by decide⟩
theorem reaches_58 : Collatz.ReachesOne 58 := ⟨19, by decide⟩

/-- assault append --/
theorem step_14 : Collatz.step 14 = 7 := by decide
theorem step_25 : Collatz.step 25 = 76 := by decide
theorem reaches_14 : Collatz.ReachesOne 14 := ⟨17, by decide⟩

/-- assault append --/
theorem step_24 : Collatz.step 24 = 12 := by decide
theorem reaches_24 : Collatz.ReachesOne 24 := ⟨10, by decide⟩
theorem reaches_76 : Collatz.ReachesOne 76 := ⟨22, by decide⟩

/-- assault append --/
theorem step_26 : Collatz.step 26 = 13 := by decide
theorem reaches_26 : Collatz.ReachesOne 26 := ⟨10, by decide⟩
theorem reaches_34 : Collatz.ReachesOne 34 := ⟨13, by decide⟩

/-- assault append --/
theorem step_33 : Collatz.step 33 = 100 := by decide
theorem reaches_100 : Collatz.ReachesOne 100 := ⟨25, by decide⟩
theorem reaches_11 : Collatz.ReachesOne 11 := ⟨14, by decide⟩

/-- assault append --/
theorem reaches_7 : Collatz.ReachesOne 7 := ⟨16, by decide⟩

/-- assault append --/
theorem reaches_12 : Collatz.ReachesOne 12 := ⟨9, by decide⟩

/-- assault append --/
theorem step_15 : Collatz.step 15 = 46 := by decide
theorem reaches_15 : Collatz.ReachesOne 15 := ⟨17, by decide⟩
theorem reaches_46 : Collatz.ReachesOne 46 := ⟨16, by decide⟩

end Collatz.Exploration
