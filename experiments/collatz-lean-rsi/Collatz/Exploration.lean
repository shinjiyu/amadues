import Collatz.Conjecture

/-!
Plan-serving lemmas only. Concrete `ReachesOne n` enumerations are **not** proof progress.
See `ProofPlan.md`.
-/

namespace Collatz.Exploration

theorem step_even (k : Nat) : Collatz.step (2 * k) = k := by
  simp [Collatz.step]

theorem step_odd (k : Nat) : Collatz.step (2 * k + 1) = 3 * (2 * k + 1) + 1 := by
  have h : (2 * k + 1) % 2 = 1 := by omega
  simp [Collatz.step, h]

theorem step_one : Collatz.step 1 = 4 := by
  simp [Collatz.step]

theorem iterate_zero (n : Nat) : Collatz.iterate 0 n = n := rfl

theorem iterate_succ (k n : Nat) :
    Collatz.iterate (k + 1) n = Collatz.step (Collatz.iterate k n) := rfl

theorem iterate_step (j n : Nat) :
    Collatz.iterate (j + 1) n = Collatz.iterate j (Collatz.step n) := by
  induction j generalizing n with
  | zero => rfl
  | succ j ih =>
    calc
      Collatz.iterate (j + 2) n
          = Collatz.step (Collatz.iterate (j + 1) n) := rfl
      _ = Collatz.step (Collatz.iterate j (Collatz.step n)) := by rw [ih]
      _ = Collatz.iterate (j + 1) (Collatz.step n) := rfl

theorem iterate_add (i j n : Nat) :
    Collatz.iterate (i + j) n = Collatz.iterate i (Collatz.iterate j n) := by
  induction i generalizing n with
  | zero => simp [Collatz.iterate]
  | succ i ih =>
    calc
      Collatz.iterate (i + 1 + j) n
          = Collatz.step (Collatz.iterate (i + j) n) := by
            rw [Nat.add_assoc, Nat.add_comm 1 j, ← Nat.add_assoc]
            rfl
      _ = Collatz.step (Collatz.iterate i (Collatz.iterate j n)) := by rw [ih]
      _ = Collatz.iterate (i + 1) (Collatz.iterate j n) := rfl

theorem reaches_iterate {n k : Nat} (h : Collatz.ReachesOne (Collatz.iterate k n)) :
    Collatz.ReachesOne n := by
  obtain ⟨i, hi⟩ := h
  refine ⟨i + k, ?_⟩
  simpa [iterate_add] using hi

theorem even_reaches {k : Nat} (h : Collatz.ReachesOne k) : Collatz.ReachesOne (2 * k) := by
  obtain ⟨i, hi⟩ := h
  refine ⟨i + 1, ?_⟩
  have : Collatz.iterate (i + 1) (2 * k) = Collatz.iterate i k := by
    rw [iterate_step, step_even]
  rw [this, hi]

theorem one_reaches_one : Collatz.ReachesOne 1 := by
  refine ⟨0, ?_⟩
  simp [Collatz.iterate]

/-- plan lemma --/
theorem after_odd_is_even (k : Nat) :
    (3 * (2 * k + 1) + 1) % 2 = 0 := by omega

/-- Two steps from odd n = 2k+1 give (3n+1)/2, which is ≥ n: no 2-step descent. -/
theorem two_step_no_descent (k : Nat) :
    Collatz.iterate 2 (2 * k + 1) = (3 * (2 * k + 1) + 1) / 2
    ∧ ¬ ((3 * (2 * k + 1) + 1) / 2 < 2 * k + 1) := by
  have h1 : Collatz.step (2 * k + 1) = 3 * (2 * k + 1) + 1 := step_odd k
  have h2 : (3 * (2 * k + 1) + 1) % 2 = 0 := after_odd_is_even k
  have hstep2 : Collatz.step (3 * (2 * k + 1) + 1) = (3 * (2 * k + 1) + 1) / 2 := by
    simp [Collatz.step, h2]
  refine ⟨by simp [Collatz.iterate, h1, hstep2], ?_⟩
  have : 3 * (2 * k + 1) + 1 = 2 * (3 * k + 2) := by omega
  rw [this]
  simp
  omega

end Collatz.Exploration
