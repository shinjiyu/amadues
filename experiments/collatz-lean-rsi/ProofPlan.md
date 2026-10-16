Approach: close two more full residue classes with explicit affine step certificates, using new helper lemmas `odd_st`/`even_st` to keep proofs short.
1. `eight_step_of_11mod32`: 32k+11 → 96k+34 → 48k+17 → 144k+52 → 72k+26 → 36k+13 → 108k+40 → 54k+20 → 27k+10; gap 5k+1>0. Closes n%32=11 entirely.
2. `eleven_step_of_7mod128`: 128k+7 → 384k+22 → 192k+11 → 576k+34 → 288k+17 → 864k+52 → 432k+26 → 216k+13 → 648k+40 → 324k+20 → 162k+10 → 81k+5; gap 47k+2>0. Closes n%128=7 (leaf of n%32=7).
3. `eleven_step_of_15mod128`: 128k+15 → ... → 432k+53 → 1296k+160 → 648k+80 → 324k+40 → 162k+20 → 81k+10; gap 47k+5>0. Closes n%128=15 (leaf of n%32=15).
Case tree in `odd_descent` refined accordingly: n%32=7 splits by n%128 ∈ {7,39,71,103}; n%32=15 splits by n%128 ∈ {15,47,79,111}.
Remaining blockers (exact sorries kept):
- n%128 ∈ {39, 71, 103} (n%32=7 leaves)
- n%128 ∈ {47, 79, 111} (n%32=15 leaves)
- n%32 ∈ {27, 31}
Next turn: mod-256 certificates for 39, mod-512 for 71/103/47/79/111, and a reduction for 27mod32 (lands in class 9 mod 16 after: 32k+27→96k+82→48k+41→144k+124→72k+62→36k+31 odd → class 15 mod 32? check: 36k+31, 2*(18k+15)+1 — 31 mod 32? no, it's 36k+31 ≡ 4k+31; OPEN, needs k-splitting certificate).
