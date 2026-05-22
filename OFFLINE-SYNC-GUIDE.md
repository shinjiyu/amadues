# Offline Sync Guide — Importing Bundle & Pushing to Remote

> **Purpose:** This guide walks you through importing the merged `main` branch from the
> `main.bundle` file into your local clone, reconciling with any remote updates, and
> pushing the final result to GitHub.
>
> **Generated:** 2026-05-15
> **Source HEAD:** `2cde3368a70f90cd88e54f6c8262a23f7203bdf0`
> **Bundle file:** `main.bundle` (932 KB, verified OK)
> **Remote origin/main:** `22943edd14cf8f543e9cc95dce89496889ecf90f`

---

## 0. Prerequisites

| Item | Requirement |
|------|-------------|
| Git | 2.20+ (for `git bundle` support) |
| Network | GitHub SSH or HTTPS access configured |
| Repository | Clone of `D:\kuroneko` (or your local copy) |
| Bundle file | `main.bundle` placed at **repository root** |

---

## 1. Verify the Bundle

Before importing, confirm the bundle is intact:

```bat
cd /d D:\kuroneko
git bundle verify main.bundle
```

Expected output:
```
The bundle contains this ref:
2cde3368a70f90cd88e54f6c8262a23f7203bdf0 HEAD
The bundle records a complete history.
main.bundle is okay
```

> If verification fails, **do not proceed** — the bundle is corrupted. Re-create it from the original environment.

---

## 2. Fetch from the Bundle

Import the bundle as a remote and fetch its contents:

```bat
git fetch main.bundle HEAD:refs/remotes/bundle/main
```

This creates a remote-tracking reference `bundle/main` pointing to commit
`2cde3368` without modifying your working tree.

Verify it arrived:

```bat
git log --oneline bundle/main -9
```

You should see all 9 commits that are ahead of origin/main:

```
2cde336 feat: add kpiId/verdict/reflexion fields to types and spawner params
5937e00 Merge branch 'feature/scheduled-tasks'
c348351 merge: feature/heartbeat-integration into main
fbeffff feat(heartbeat): integrate agent behavior logging and death detection
80d5cb6 merge: feature/heartbeat-python into main
730ed0c feat(heartbeat): update Python prototype with 85 tests
22943ed merge: feature/heartbeat-prototype into main
35fa7c5 feat(heartbeat): add TS prototype + Python translation with 45 passing tests
c0bf2eb feat: add heartbeat prototype module with agent, environment, types and tests
```

---

## 3. Update from Remote First

Before merging, pull any new commits from GitHub that may have been pushed
by others:

```bat
git fetch origin
git log --oneline origin/main -5
```

Compare with your local main:

```bat
git log --oneline main..origin/main
```

- **If empty** — origin/main has no new commits. Skip to Step 4.
- **If commits appear** — you need to reconcile (see Step 3a).

### 3a. Reconcile Diverged Histories (only if remote has new commits)

If origin/main has commits not in your local main, you have two options:

**Option A — Rebase (cleaner history, recommended if no conflicts):**

```bat
git checkout main
git rebase origin/main
git rebase origin/main bundle/main --onto main
```

**Option B — Merge (preserves both histories):**

```bat
git checkout main
git merge origin/main
git merge bundle/main
```

If conflicts arise, resolve them manually, then:

```bat
git add <resolved-files>
git commit
```

---

## 4. Merge Bundle into Local Main

If your local main is already up-to-date with origin/main (the common case),
fast-forward or merge the bundle reference:

```bat
git checkout main
git merge bundle/main
```

If main is behind bundle/main with no divergence, this will be a fast-forward.

---

## 5. Verify the Merge Result

### 5a. Check HEAD matches expected commit

```bat
git rev-parse HEAD
```

Should output: `2cde3368a70f90cd88e54f6c8262a23f7203bdf0`
(unless Step 3a created new merge commits).

### 5b. Verify all 9 feature commits are present

```bat
git log --oneline origin/main..HEAD
```

Should list at least 9 commits covering:
- Heartbeat prototype (Python + TS)
- Heartbeat integration
- Scheduled tasks
- KPI/verdict/reflexion type extensions

### 5c. Build verification

```bat
npm run build
```

All 6 workspaces must compile with zero errors:
- `@utlra/chat-ir` (tsc)
- `@utlra/core` (tsc)
- `@utlra/discord-bridge` (tsc)
- `@utlra/server` (tsc)
- `@utlra/dashboard` (vite)
- `@utlra/ops-console` (vite)

### 5d. Quick smoke test (optional)

```bat
git diff --stat origin/main..HEAD
```

This shows which files changed. Expect changes in:
- `packages/server/src/heartbeat/`
- `packages/server/src/outer/`
- `src/heartbeat/`
- Type definition files

---

## 6. Push to Remote

Once verification passes:

```bat
git push origin main
```

If the push is rejected (remote has new commits you didn't catch in Step 3):

```bat
git pull --rebase origin main
git push origin main
```

---

## 7. Post-Push Verification

```bat
git fetch origin
git log --oneline origin/main -9
git status
```

Confirm:
- `origin/main` HEAD matches your local HEAD
- `git status` shows "Your branch is up to date with 'origin/main'"

---

## 8. Cleanup (Optional)

Remove the temporary bundle remote reference:

```bat
git remote remove bundle 2>nul
del main.bundle
```

---

## Quick-Reference Command Sequence (Happy Path)

Assuming no remote divergence:

```bat
cd /d D:\kuroneko
git bundle verify main.bundle
git fetch main.bundle HEAD:refs/remotes/bundle/main
git fetch origin
git checkout main
git merge bundle/main
npm run build
git push origin main
git fetch origin
git log --oneline origin/main -9
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `git bundle verify` fails | Bundle is corrupted; re-create from source environment |
| `fatal: refusing to fetch into checked out branch` | Checkout a different branch first, or use `FETCH_HEAD` approach: `git fetch main.bundle HEAD` then `git merge FETCH_HEAD` |
| Merge conflicts in Step 3a/4 | Resolve manually: `git mergetool` or edit files, then `git add` + `git commit` |
| `npm run build` fails | Do NOT push. Check error output, resolve type errors, re-run build |
| `git push` rejected | Remote has newer commits — `git pull --rebase origin main` then retry push |
| Credentials prompt | Ensure GitHub SSH key or GCM is configured: `git config credential.helper` |

---

## What Was Merged (Summary)

| Branch | Merge Commit | Description |
|--------|-------------|-------------|
| `feature/heartbeat-prototype` | `22943ed` | TS + Python heartbeat prototype with 45→85 passing tests |
| `feature/heartbeat-python` | `80d5cb6` | Python prototype expansion (85 tests, lifecycle, factory) |
| `feature/heartbeat-integration` | `c348351` | Agent behavior logging, death detection, integration into server |
| `feature/scheduled-tasks` | `5937e00` | Scheduled tasks feature branch |

**Total new commits on main:** 9 (ahead of origin/main at `22943edd`)

---

*End of guide. For questions, refer to `.tool-outputs/merge-status.md` for the full merge status report.*
