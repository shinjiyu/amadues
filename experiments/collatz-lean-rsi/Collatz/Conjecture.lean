/-!
# Collatz (3n+1) — **AGENT GOAL: prove this theorem**

Task success = this file typechecks with **no `sorry`** in `conjecture`.
`lake build` is a craft constraint, not a substitute for a proof.
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

/-- Every positive `n` eventually reaches 1. -/
def ReachesOne (n : Nat) : Prop :=
  ∃ k, iterate k n = 1

theorem step_even (k : Nat) : step (2 * k) = k := by
  simp [step]

theorem iterate_step (j n : Nat) : iterate (j + 1) n = iterate j (step n) := by
  induction j generalizing n with
  | zero => rfl
  | succ j ih =>
    calc
      iterate (j + 2) n = step (iterate (j + 1) n) := rfl
      _ = step (iterate j (step n)) := by rw [ih]
      _ = iterate (j + 1) (step n) := rfl

theorem iterate_add (i j n : Nat) : iterate (i + j) n = iterate i (iterate j n) := by
  induction i generalizing n with
  | zero => simp [iterate]
  | succ i ih =>
    calc
      iterate (i + 1 + j) n = step (iterate (i + j) n) := by
        rw [Nat.add_assoc, Nat.add_comm 1 j, ← Nat.add_assoc]
        rfl
      _ = step (iterate i (iterate j n)) := by rw [ih]
      _ = iterate (i + 1) (iterate j n) := rfl

theorem reaches_iterate {n k : Nat} (h : ReachesOne (iterate k n)) : ReachesOne n := by
  obtain ⟨i, hi⟩ := h
  refine ⟨i + k, ?_⟩
  simpa [iterate_add] using hi

theorem even_reaches {k : Nat} (h : ReachesOne k) : ReachesOne (2 * k) := by
  obtain ⟨i, hi⟩ := h
  refine ⟨i + 1, ?_⟩
  have : iterate (i + 1) (2 * k) = iterate i k := by
    rw [iterate_step, step_even]
  rw [this, hi]

/-! ### Descent for n ≡ 1 (mod 4): three steps, fully proved. -/

theorem three_step_of_1mod4 (k : Nat) : iterate 3 (4 * k + 1) = 3 * k + 1 := by
  have s1 : step (4 * k + 1) = 12 * k + 4 := by
    have h : (4 * k + 1) % 2 = 1 := by omega
    simp [step, h]
    omega
  have s2 : step (12 * k + 4) = 6 * k + 2 := by
    have h : (12 * k + 4) % 2 = 0 := by omega
    simp [step, h]
    omega
  have s3 : step (6 * k + 2) = 3 * k + 1 := by
    have h : (6 * k + 2) % 2 = 0 := by omega
    simp [step, h]
    omega
  show step (step (step (4 * k + 1))) = 3 * k + 1
  rw [s1, s2, s3]

theorem odd_descent_1mod4 (n : Nat) (hmod : n % 4 = 1) (hgt : n > 1) :
    ∃ k, k > 0 ∧ iterate k n < n ∧ iterate k n > 0 := by
  have hk : n = 4 * (n / 4) + 1 := by omega
  have hk1 : n / 4 ≥ 1 := by omega
  refine ⟨3, by omega, ?_, ?_⟩
  · rw [hk, three_step_of_1mod4]
    omega
  · rw [hk, three_step_of_1mod4]
    omega

/-! ### Descent for n ≡ 3 (mod 16): six steps, fully proved. -/

theorem six_step_of_3mod16 (k : Nat) : iterate 6 (16 * k + 3) = 9 * k + 2 := by
  have s1 : step (16 * k + 3) = 48 * k + 10 := by
    have h : (16 * k + 3) % 2 = 1 := by omega
    simp [step, h]
    omega
  have s2 : step (48 * k + 10) = 24 * k + 5 := by
    have h : (48 * k + 10) % 2 = 0 := by omega
    simp [step, h]
    omega
  have s3 : step (24 * k + 5) = 72 * k + 16 := by
    have h : (24 * k + 5) % 2 = 1 := by omega
    simp [step, h]
    omega
  have s4 : step (72 * k + 16) = 36 * k + 8 := by
    have h : (72 * k + 16) % 2 = 0 := by omega
    simp [step, h]
    omega
  have s5 : step (36 * k + 8) = 18 * k + 4 := by
    have h : (36 * k + 8) % 2 = 0 := by omega
    simp [step, h]
    omega
  have s6 : step (18 * k + 4) = 9 * k + 2 := by
    have h : (18 * k + 4) % 2 = 0 := by omega
    simp [step, h]
    omega
  show step (step (step (step (step (step (16 * k + 3)))))) = 9 * k + 2
  rw [s1, s2, s3, s4, s5, s6]

theorem odd_descent_3mod16 (n : Nat) (hmod : n % 16 = 3) :
    ∃ k, k > 0 ∧ iterate k n < n ∧ iterate k n > 0 := by
  have hk : n = 16 * (n / 16) + 3 := by omega
  refine ⟨6, by omega, ?_, ?_⟩
  · rw [hk, six_step_of_3mod16]
    omega
  · rw [hk, six_step_of_3mod16]
    omega

/-! ### Descent for n ≡ 23 (mod 32): eight steps, fully proved.
    32k+23 → 96k+70 → 48k+35 → 144k+106 → 72k+53 → 216k+160 → 108k+80
    → 54k+40 → 27k+20, and 27k+20 < 32k+23 ⟺ 5k+3 > 0. -/

theorem eight_step_of_23mod32 (k : Nat) : iterate 8 (32 * k + 23) = 27 * k + 20 := by
  have s1 : step (32 * k + 23) = 96 * k + 70 := by
    have h : (32 * k + 23) % 2 = 1 := by omega
    simp [step, h]
    omega
  have s2 : step (96 * k + 70) = 48 * k + 35 := by
    have h : (96 * k + 70) % 2 = 0 := by omega
    simp [step, h]
    omega
  have s3 : step (48 * k + 35) = 144 * k + 106 := by
    have h : (48 * k + 35) % 2 = 1 := by omega
    simp [step, h]
    omega
  have s4 : step (144 * k + 106) = 72 * k + 53 := by
    have h : (144 * k + 106) % 2 = 0 := by omega
    simp [step, h]
    omega
  have s5 : step (72 * k + 53) = 216 * k + 160 := by
    have h : (72 * k + 53) % 2 = 1 := by omega
    simp [step, h]
    omega
  have s6 : step (216 * k + 160) = 108 * k + 80 := by
    have h : (216 * k + 160) % 2 = 0 := by omega
    simp [step, h]
    omega
  have s7 : step (108 * k + 80) = 54 * k + 40 := by
    have h : (108 * k + 80) % 2 = 0 := by omega
    simp [step, h]
    omega
  have s8 : step (54 * k + 40) = 27 * k + 20 := by
    have h : (54 * k + 40) % 2 = 0 := by omega
    simp [step, h]
    omega
  show step (step (step (step (step (step (step (step (32 * k + 23)))))))) = 27 * k + 20
  rw [s1, s2, s3, s4, s5, s6, s7, s8]

theorem odd_descent_23mod32 (n : Nat) (hmod : n % 32 = 23) :
    ∃ k, k > 0 ∧ iterate k n < n ∧ iterate k n > 0 := by
  have hk : n = 32 * (n / 32) + 23 := by omega
  refine ⟨8, by omega, ?_, ?_⟩
  · rw [hk, eight_step_of_23mod32]
    omega
  · rw [hk, eight_step_of_23mod32]
    omega

/-- Odd-branch descent: some positive iterate of an odd `n > 1` drops below `n`.
    Proved for n ≡ 1 (mod 4), n ≡ 3 (mod 16), n ≡ 23 (mod 32);
    the remaining `sorry` is exactly n % 32 ∈ {7, 11, 15, 27, 31}. -/
theorem odd_descent (n : Nat) (hodd : n % 2 = 1) (hgt : n > 1) :
    ∃ k, k > 0 ∧ iterate k n < n ∧ iterate k n > 0 := by
  have hm : n % 4 = 1 ∨ n % 4 = 3 := by omega
  cases hm with
  | inl h1 => exact odd_descent_1mod4 n h1 hgt
  | inr h3 =>
    have hr : n % 16 = 3 ∨ n % 16 = 7 ∨ n % 16 = 11 ∨ n % 16 = 15 := by omega
    cases hr with
    | inl h3' => exact odd_descent_3mod16 n h3'
    | inr hrest =>
      -- n % 16 ∈ {7, 11, 15}; refine by n % 32.
      have hr32 : n % 32 = 7 ∨ n % 32 = 23 ∨ n % 32 = 11 ∨ n % 32 = 27 ∨
          n % 32 = 15 ∨ n % 32 = 31 := by omega
      cases hr32 with
      | inl _ => -- 7 mod 32: OPEN
        sorry
      | inr h' => cases h' with
        | inl h23 => exact odd_descent_23mod32 n h23
        | inr h' => cases h' with
          | inl _ => -- 11 mod 32: OPEN
            sorry
          | inr h' => cases h' with
            | inl _ => -- 27 mod 32: OPEN
              sorry
            | inr h' => cases h' with
              | inl _ => -- 15 mod 32: OPEN
                sorry
              | inr _ => -- 31 mod 32: OPEN
                sorry

/-- **Prove me.** Structure is wired; remaining `sorry` is only via `odd_descent`,
    only for odd n with n % 32 ∈ {7, 11, 15, 27, 31}. -/
theorem conjecture : ∀ n : Nat, n > 0 → ReachesOne n := by
  intro n0
  refine Nat.strongRecOn (motive := fun n => n > 0 → ReachesOne n) n0 ?_
  intro n ih hpos
  have hparity : n % 2 = 0 ∨ n % 2 = 1 := by omega
  cases hparity with
  | inl heven =>
    have hn2 : n / 2 < n := Nat.div_lt_self hpos (by decide : 1 < 2)
    have hpos2 : n / 2 > 0 := by
      have : n ≠ 1 := by
        intro h; subst h; simp at heven
      omega
    have hhalf : ReachesOne (n / 2) := ih (n / 2) hn2 hpos2
    have hn : n = 2 * (n / 2) := by omega
    rw [hn]
    exact even_reaches hhalf
  | inr hodd =>
    by_cases h1 : n = 1
    · subst h1
      exact ⟨0, rfl⟩
    · have hgt : n > 1 := by omega
      obtain ⟨k, _hkpos, hklt, hkpos'⟩ := odd_descent n hodd hgt
      have hreach : ReachesOne (iterate k n) := ih (iterate k n) hklt hkpos'
      exact reaches_iterate hreach

end Collatz
