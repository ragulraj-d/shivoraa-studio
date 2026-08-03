# Deploying to `studio.shivoraa.in`

Firebase Hosting serves the SPA. Cloud Run runs the API. Neon (or Cloud SQL)
holds the database. GitHub Actions ships both on every push to `main`.

```
studio.shivoraa.in  →  Firebase Hosting   (React SPA, global CDN)
api.shivoraa.in     →  Cloud Run          (FastAPI, scales to zero)
                    →  Neon / Cloud SQL   (PostgreSQL)
```

**Why the API is not on Firebase Hosting:** Hosting only serves static files, and
its rewrite proxy buffers responses. That would break the AI panel's SSE
streaming — answers would arrive in one lump after a delay, or hit the 60-second
timeout. Cloud Run streams properly and runs the existing Docker image unchanged.

Both hosts are subdomains of `shivoraa.in`, so they are **same-site**. The
refresh cookie keeps working with `SameSite=Lax`; no third-party cookie problems.

---

## One-time setup

### 1. Google Cloud project

```bash
# Project "shivoraa" already exists — just select it
gcloud config set project shivoraa

# Link billing (required for Cloud Run — the free tier still needs a card)
gcloud beta billing projects link shivoraa --billing-account=YOUR_BILLING_ID

gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  firebasehosting.googleapis.com \
  iamcredentials.googleapis.com

gcloud artifacts repositories create shivoraa \
  --repository-format=docker --location=asia-south1
```

### 2. Database

Neon has a genuinely free Postgres tier and is the fastest path:

1. Sign up at neon.tech, create a project in a region near `asia-south1`
2. Copy the connection string
3. Change the scheme to `postgresql+asyncpg://` (SQLAlchemy needs the async driver)

```
postgresql+asyncpg://user:pass@ep-xxx.ap-southeast-1.aws.neon.tech/shivoraa?ssl=require
```

Cloud SQL works too and keeps everything in one project, but costs ~$10/month
minimum where Neon's free tier is $0.

### 3. Secrets

```bash
# Generate real values — never reuse the development defaults
openssl rand -hex 32                                     # SECRET_KEY
python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"

printf 'YOUR_DATABASE_URL' | gcloud secrets create shivoraa-database-url   --data-file=-
printf 'YOUR_SECRET_KEY'   | gcloud secrets create shivoraa-secret-key     --data-file=-
printf 'YOUR_FERNET_KEY'   | gcloud secrets create shivoraa-encryption-key --data-file=-
```

> **Guard the encryption key.** It decrypts every stored provider API key and
> secret environment variable. Lose it and that data is unrecoverable; rotate it
> and existing secrets stop decrypting. Keep a copy somewhere safe now.

### 4. GitHub → Google Cloud (no long-lived keys)

Workload Identity Federation lets Actions authenticate without a downloadable
service-account JSON, which is the credential most likely to leak.

```bash
PROJECT_NUMBER=$(gcloud projects describe shivoraa --format='value(projectNumber)')

gcloud iam service-accounts create github-deployer

gcloud iam workload-identity-pools create github --location=global
gcloud iam workload-identity-pools providers create-oidc github \
  --location=global --workload-identity-pool=github \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='ragulraj-d/shivoraa-studio'"

gcloud iam service-accounts add-iam-policy-binding \
  github-deployer@shivoraa.iam.gserviceaccount.com \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/attribute.repository/ragulraj-d/shivoraa-studio"

for ROLE in run.admin artifactregistry.writer secretmanager.secretAccessor \
            firebasehosting.admin iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding shivoraa \
    --member="serviceAccount:github-deployer@shivoraa.iam.gserviceaccount.com" \
    --role="roles/${ROLE}"
done
```

Then add these repository secrets in GitHub
(**Settings → Secrets and variables → Actions**):

| Secret | Value |
|---|---|
| `GCP_PROJECT_ID` | `shivoraa` |
| `GCP_SERVICE_ACCOUNT` | `github-deployer@shivoraa.iam.gserviceaccount.com` |
| `GCP_WIF_PROVIDER` | `projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/github` |
| `DATABASE_URL` | the Neon connection string (used for migrations) |
| `SHIVORAA_SECRET_KEY` | same value as the secret above |
| `SHIVORAA_ENCRYPTION_KEY` | same value as the secret above |

### 5. Firebase Hosting — as a SECOND site

`shivoraa.in` is already live on Firebase. Do **not** create a new project or
deploy to the default site; add a second Hosting site alongside the existing one.

```bash
firebase login
firebase projects:list                 # find the project that serves shivoraa.in

# Create a second site in that SAME project
firebase hosting:sites:create shivoraa-studio --project shivoraa

# Bind it to the "studio" deploy target
firebase target:apply hosting studio shivoraa-studio --project shivoraa
```

Then put your real project ID into `.firebaserc` (both places).

> **Why a deploy target rather than a site name.** With a target configured,
> every deploy must name it — `firebase deploy --only hosting:studio`. A bare
> `firebase deploy` cannot publish over `shivoraa.in`. That guard is the whole
> reason this is set up as a target.

### 6. DNS

| Record | Name | Points to |
|---|---|---|
| A / TXT | `studio` | values Firebase shows in **Hosting → Add custom domain** |
| CNAME | `api` | `ghs.googlehosted.com` (after mapping the Cloud Run domain) |

```bash
gcloud beta run domain-mappings create \
  --service shivoraa-api --domain api.shivoraa.in --region asia-south1
```

Certificates issue automatically once DNS propagates — usually minutes, but
allow up to a few hours.

---

## Deploying

```bash
git push origin main
```

That is the whole deploy. The workflow runs tests, builds and pushes the API
image, applies migrations, rolls out Cloud Run, smoke-tests `/health`, then
builds and publishes the SPA. If anything fails the previous revision keeps
serving.

Manual runs: **Actions → Deploy → Run workflow**.

### Rolling back

```bash
gcloud run services update-traffic shivoraa-api \
  --to-revisions=PREVIOUS_REVISION=100 --region asia-south1

firebase hosting:rollback
```

---

## Costs

| Service | Realistic early cost |
|---|---|
| Firebase Hosting | Free (10 GB/month) |
| Cloud Run | ~Free — scales to zero, 2M requests/month included |
| Neon Postgres | Free tier |
| Artifact Registry | ~$0.10/month |
| Domain | Already owned |

Effectively free until real traffic arrives. Cloud Run cold starts add roughly
one to two seconds on the first request after idle; set `--min-instances 1`
(~$5/month) if that matters.

---

## Verifying a deploy

```bash
curl https://api.shivoraa.in/health          # {"status":"ok",...}
curl https://api.shivoraa.in/ready           # proves the database is reachable
curl -I https://studio.shivoraa.in           # 200, HSTS header present
```

Then sign up on `studio.shivoraa.in` and send a request. Check the browser
DevTools **Application → Cookies**: `__Host-sv_refresh` should be present on
`api.shivoraa.in`, marked `HttpOnly` and `Secure`.

---

## Self-hosting instead

`docker-compose.prod.yml` and `infra/Caddyfile` run the whole stack on a single
VPS with automatic TLS, if you would rather not use Google Cloud:

```bash
cp .env.example .env    # fill in real secrets
docker compose -f docker-compose.prod.yml up -d --build
```

Point `studio.shivoraa.in` at the server's IP. Caddy handles certificates.
