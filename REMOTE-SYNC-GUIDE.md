# Remote Sync & Push Guide

> **Target Repository**: `D:\kuroneko`
> **Branch**: `main` (HEAD: `2cde3368a70f90cd88e54f6c8262a23f7203bdf0`)
> **Generated**: 2025-05-15 | Milestone M3

---

## 1. Current State Summary

| Item | Value |
|------|-------|
| Current branch | `main` |
| Local HEAD | `2cde3368` |
| Remote HEAD (origin/main) | `22943edd` |
| Commits ahead of origin | **9** |
| Commits behind origin | 0 |
| Unmerged feature branches | None (all 4 already merged) |

### Merged Feature Branches

| Branch | Merge Commit | Status |
|--------|-------------|--------|
| `feature/heartbeat-integration` | `c3483517` | Merged into main |
| `feature/heartbeat-prototype` | (squash/merged) | Merged into main |
| `feature/heartbeat-python` | `80d5cb6` (parent) | Merged into main |
| `feature/scheduled-tasks` | `5937e00` | Merged into main |

### Commits to Push (9 total)

```
2cde336 feat: add kpiId/verdict/reflexion fields to types and spawner params
5937e00 Merge branch 'feature/scheduled-tasks'
c348351 merge: feature/heartbeat-integration into main
fbeffff feat(heartbeat): integrate agent behavior logging and death detection
80d5cb6 merge: feature/heartbeat-python into main
730ed0c feat(heartbeat): update Python prototype with 85 tests
646a152 Merge branch 'test/git-permission-check' into feature/scheduled-tasks
4f4d4e4 feat(scheduled-tasks): complete scheduled-tasks module with e2e integration tests
78ea36f feat(scheduled-tasks): implement scheduled task scheduling system module
```

---

## 2. Option A: Automated Script (Recommended)

Run the companion script from a **real terminal** (not sandbox):

```cmd
cd /d D:\kuroneko
SYNC-AND-PUSH.bat
```

The script will:

1. Verify you are on `main` branch (aborts otherwise)
2. Show working tree status
3. `git fetch origin` to get latest remote state
4. Check if remote has commits you don't have locally (offers `git pull --rebase`)
5. Verify all 4 feature branches are merged into main
6. Show the commit list to be pushed
7. Ask for confirmation (type `YES`)
8. Execute `git push origin main`
9. Verify post-push state

---

## 3. Option B: Manual Step-by-Step

If you prefer manual control, follow these steps in order:

### Step 1: Navigate to repo
```cmd
cd /d D:\kuroneko
```

### Step 2: Confirm branch
```cmd
git rev-parse --abbrev-ref HEAD
```
> Must output `main`. If not: `git checkout main`

### Step 3: Fetch remote
```cmd
git fetch origin
```

### Step 4: Check for divergence
```cmd
git rev-list --count HEAD..origin/main
```
- If output is `0`: local is up to date, proceed to Step 6
- If output > 0: remote has new commits, rebase first:

```cmd
git pull --rebase origin main
```

### Step 5: Resolve conflicts (if any)
If rebase reports conflicts:
1. Open each conflicted file, resolve markers (`<<<<<<<`, `=======`, `>>>>>>>`)
2. `git add <resolved-files>`
3. `git rebase --continue`
4. Repeat until rebase completes

### Step 6: Verify feature branches are merged
```cmd
git branch --merged main
```
> All 4 feature branches should appear in the list.

If any are missing:
```cmd
git merge <branch-name>
```

### Step 7: Review commits to push
```cmd
git log --oneline origin/main..HEAD
```
> Should show 9 commits (or more if you added new ones)

### Step 8: Push
```cmd
git push origin main
```

### Step 9: Verify
```cmd
git log --oneline -5 origin/main
git status
```

---

## 4. Troubleshooting

### "fatal: not a git repository"
- Ensure you are in `D:\kuroneko` (contains `.git/` directory)
- Run `cd /d D:\kuroneko` and try again

### Authentication failure / credential prompt loops
- Install Git Credential Manager: `winget install Git.Git`
- Or use SSH: change remote URL with `git remote set-url origin git@github.com:<user>/<repo>.git`
- Or use PAT: `git remote set-url origin https://<PAT>@github.com/<user>/<repo>.git`

### "Updates were rejected because the remote contains work"
- Remote has commits not in your local. Rebase first:
  ```cmd
  git pull --rebase origin main
  git push origin main
  ```

### Push succeeds but CI fails
- Check build: `npm run build`
- Review the failed CI job logs on GitHub

### Untracked files warning
- The repo has several untracked files (test scripts, temp files). These are NOT committed and will NOT be pushed. This is expected and harmless.

---

## 5. Post-Push Checklist

- [ ] `git push origin main` completed without error
- [ ] `git log --oneline -5 origin/main` shows the latest commits
- [ ] `npm run build` passes (optional, verifies build integrity)
- [ ] GitHub remote shows the new commits on `main` branch
- [ ] (Optional) Clean up local feature branches:
  ```cmd
  git branch -d feature/heartbeat-integration
  git branch -d feature/heartbeat-prototype
  git branch -d feature/heartbeat-python
  git branch -d feature/scheduled-tasks
  git push origin --delete feature/heartbeat-integration
  git push origin --delete feature/heartbeat-prototype
  git push origin --delete feature/heartbeat-python
  git push origin --delete feature/scheduled-tasks
  ```

---

## 6. Important Notes

1. **Why this is manual**: The sandbox environment (UGit/Hutao) intercepts `git push` commands. All other git operations work, but push requires a real terminal with proper GitHub credentials.

2. **No data loss risk**: All feature branches are already merged into main. The 9 local commits are safe and ready to push.

3. **Encoding**: The `.bat` script uses `chcp 65001` for UTF-8 support. If characters appear garbled, run `chcp 65001` manually before running the script.

4. **Stash**: There are 3 git stashes in the repo. These are local-only and will NOT be affected by push operations.
