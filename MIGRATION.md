# Moving to GitLab

`.gitlab-ci.yml` already mirrors the GitHub pipeline stage for stage, so the
move is mostly plumbing. The one thing that does not transfer is the deploy
credential — read that section before starting.

---

## 1 · Push the repository

```bash
# Create an empty project on GitLab first — no README, no .gitignore.
git remote rename origin github
git remote add origin https://gitlab.com/<you>/shivoraa-studio.git
git push -u origin main
```

Keeping the old remote as `github` means you can push to both while you settle
in, and roll back without re-adding anything.

---

## 2 · Recreate the deploy credential

**This is the part that cannot be copied.** GitHub secrets are write-only — you
cannot read `FIREBASE_SERVICE_ACCOUNT_SHIVORAA` back out, and neither can
anyone else. You need a fresh key for the same service account.

Google Cloud Console → **IAM & Admin → Service Accounts** → the
`github-action-…@shivoraa.iam.gserviceaccount.com` account → **Keys → Add key →
Create new key → JSON**.

Then in GitLab: **Settings → CI/CD → Variables → Add variable**

| | |
|---|---|
| Key | `FIREBASE_SERVICE_ACCOUNT` |
| Value | the entire JSON file contents, braces included |
| Type | **File** |
| Flags | **Protected** — leave **Masked** off |

Two things that will otherwise cost you an hour:

- **Type must be File, not Variable.** GitLab writes a File variable to disk and
  hands the job a path, which is exactly what `GOOGLE_APPLICATION_CREDENTIALS`
  wants.
- **Masking cannot be enabled.** GitLab only masks single-line values with no
  spaces or special characters, and a service account key is none of those. If
  you tick Masked it is either rejected or silently not applied, and the job
  sees an empty value — which the Firebase CLI reports as
  *"Failed to authenticate, have you run firebase login?"*, sending you after
  entirely the wrong problem.

  Not masking is fine here: a File variable never appears in job output, and
  Protected keeps it off unprotected branches.

Protected matters: it restricts the variable to protected branches, so a merge
request from a fork cannot run a job that reads your deploy key.

> The account is still named `github-action-…`. Renaming it means new keys and
> new IAM bindings for no benefit — leave it, or create a fresh `gitlab-deploy`
> account if the name bothers you.

---

## 3 · Protect `main`

**Settings → Repository → Protected branches** → `main` → Allowed to push:
*No one*, Allowed to merge: *Maintainers*.

Without this, the protected CI/CD variable above has nothing to protect.

---

## 4 · Watch the first pipeline

Push anything to `main`. Expect:

```
lint → test → build → security → deploy → verify
```

Two things to check on the first run:

- **`secret_detection` and `sast`** appear and pass. Both are Free tier.
  Dependency Scanning is Ultimate-only and is deliberately not included — the
  `pip-audit` and `npm audit` jobs cover the same ground on any plan.
- **`deploy:firebase`** succeeds. If it fails on credentials, the variable was
  not marked Protected and the branch is not protected — GitLab silently omits
  protected variables from unprotected refs rather than erroring clearly.

---

## 5 · Cut over

Once a GitLab pipeline has deployed successfully:

```bash
git rm -r .github/workflows
git rm .gitleaks.toml          # GitLab's Secret Detection replaces it
git commit -m "Move CI to GitLab"
git push
```

Then update the CI badge in `README.md`, and archive the GitHub repository
rather than deleting it — the history is identical, but an archived repo keeps
old links working.

---

## What does not change

- **Firebase** stays exactly as it is. Hosting, Auth, Firestore, the custom
  domain and the rules are all independent of where the code lives.
- **`studio.shivoraa.in`** keeps serving throughout. The migration changes who
  runs the deploy, not what is deployed.
- **The VS Code extension** is unaffected. It talks to Firebase, not to a forge.

## What to double-check afterwards

The `verify` stage proves the site is live, the example API still sends its
CORS header, and `shivoraa.in` is still serving its own content. If that stage
passes on GitLab, the migration is complete — there is nothing else to confirm
by hand.
