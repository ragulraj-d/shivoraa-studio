# Deploying

Everything runs on Firebase, on the free **Spark** plan. No servers, no card, no
third-party hosting.

```
studio.shivoraa.in   →  Firebase Hosting    the app
                     →  Firebase Auth       email · Google · guest
                     →  Cloud Firestore     all data
```

Spark does not include Cloud Functions, and this deployment does not need them.
Requests are sent from the browser with `fetch()`; AI calls go straight from the
browser to your provider.

---

## Console toggles — the only manual step

The CLI cannot enable sign-in providers, so these three switches must be flipped
once by hand at
[**Authentication → Sign-in method**](https://console.firebase.google.com/project/shivoraa/authentication/providers):

| Provider | Why |
|---|---|
| **Email/Password** | Enable |
| **Google** | Enable, pick a support email |
| **Anonymous** | Enable — this is what "Continue as guest" uses |

Then add your domains at **Authentication → Settings → Authorized domains**:

```
shivoraa-studio.web.app
studio.shivoraa.in
localhost
```

Without that last step Google sign-in fails with `auth/unauthorized-domain`.

Everything else — the Firestore database, its security rules, indexes, the web
app registration, and the deploy credential — is already provisioned.

---

## Custom domain

Firebase Console → Hosting → the **shivoraa-studio** site → **Add custom domain**
→ `studio.shivoraa.in`, then add the DNS records it shows.

The primary `shivoraa` site serving `shivoraa.in` is untouched by this repo: the
deploy target is scoped to `studio`, so a bare `firebase deploy` fails rather
than publishing over it.

---

## Deploying

```bash
git push origin main
```

That is the whole deploy. GitHub Actions runs the tests, builds the app, checks
the bundle budget, publishes to Firebase Hosting, and verifies the site responds
with 200. A failing test stops the release before it reaches users.

Rules and indexes are deployed separately when they change:

```bash
firebase deploy --only firestore:rules --project shivoraa
firebase deploy --only firestore:indexes --project shivoraa
```

### Rolling back

```bash
firebase hosting:rollback
```

---

## Security model

With no server in the request path, **`firestore.rules` is the entire
authorization layer**. Every read and write from every browser is checked there
and nowhere else.

The model: data lives under a workspace, and a workspace carries a
`members` map of `uid → role`. Access is decided by looking up the caller's uid
in that map.

Three rules worth knowing:

- **`ownerId` is immutable on update.** Without that, an editor could rewrite the
  field and promote themselves to owner.
- **On create, the caller must make themselves owner.** Otherwise someone could
  create a workspace listing another user, or add themselves to one.
- **History is append-only.** Editing a past execution would let someone rewrite
  what actually happened.

AI provider keys are deliberately **not** stored in Firestore. They stay in
browser storage and are used only for direct calls to the provider, so a
credential never sits in a database.

---

## Free tier limits

| | Spark limit | Realistic use |
|---|---|---|
| Firestore storage | 1 GiB | Thousands of collections |
| Firestore reads | 50,000/day | ~1,000 app opens |
| Firestore writes | 20,000/day | Plenty |
| Hosting transfer | 10 GB/month | Plenty |
| Auth | Unlimited | — |

Collections load in two reads rather than one per collection, specifically
because reads are the metered resource.

---

## Running locally

```bash
make web     # → localhost:5173, talks to the same Firebase project
```

To use the FastAPI backend instead — needed for CORS-blocked APIs, since the
server proxies where a browser cannot:

```bash
make api     # → localhost:8000, SQLite, no Postgres required
```
