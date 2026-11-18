# Deploying 100% Stock Central Bifrost on Google Cloud Run (`central-bifrost` Mode)

This folder provides a **100% unmodified OSS `bifrost-http` container bundle** (zero sidecars, zero Python runtime, zero custom code inside Bifrost) for hosting the **Bifrost AI Gateway** centrally on **Google Cloud Run** while developers run **OpenCode** + **`opencode-bifrost-agy` (`v2.0.6+`)** + **Antigravity CLI (`agy`)** on remote laptops or VMs behind NAT.

> [!TIP]
> **Already running an existing Central Bifrost deployment on GKE, ECS, or VMs?** You don't even need this `Dockerfile`—simply deploy [`deploy/receipt-echo-service/`](../receipt-echo-service/README.md), paste its HTTPS URL into **Custom Provider (`agy-cli`) &rarr; Base URL** in your existing Bifrost Admin UI, and click **Governance &rarr; Virtual Keys &rarr; + Create Virtual Key**!

---

## Files Included

| File | Purpose |
| :--- | :--- |
| [`Dockerfile`](Dockerfile) | Minimal `debian:bookworm-slim` runtime packaging **only** unmodified `bifrost-http` (`:8080`) + `ca-certificates`. |
| [`entrypoint.sh`](entrypoint.sh) | Renders `/tmp/bifrost-data/config.json` with `0600` permissions and `exec`s stock `bifrost-http`. |
| [`receipt_bridge.py`](receipt_bridge.py) | *(Optional alternative)* Loopback receipt handler if you choose to co-locate on `127.0.0.1:8091` instead of using the external [`deploy/receipt-echo-service/`](../receipt-echo-service/README.md). |

---

## Step-by-Step Deployment (Zero Manual Key Editing)

### Step 1: Auto-Generate All 4 Keys in Google Cloud Secret Manager (One Copy-Paste Block)

Run this single block once—it generates strong random values via `openssl`, stores all 4 secrets in Secret Manager, grants access to your Cloud Run service account, and prints the **two developer Virtual Keys** at the end:

```bash
export GCP_PROJECT_ID="<YOUR_GCP_PROJECT_ID>"
export REGION="us-central1"
export SA_NAME="bifrost-central-sa"
export SA_EMAIL="${SA_NAME}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"

# 1. Create dedicated Cloud Run Service Account (for Vertex AI ADC + Secret Manager)
gcloud iam service-accounts create "${SA_NAME}" --project="${GCP_PROJECT_ID}" || true
gcloud projects add-iam-policy-binding "${GCP_PROJECT_ID}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/aiplatform.user"

# 2. Generate all 4 secrets automatically (2 admin infrastructure secrets + 2 developer Virtual Keys)
ADMIN_PW="$(openssl rand -base64 18)"
SHIM_SECRET="$(openssl rand -hex 24)"
VK_STD="sk-bf-std-$(openssl rand -hex 16)"
VK_AGY="sk-bf-agy-$(openssl rand -hex 16)"

for pair in \
  "bifrost-admin-pw:${ADMIN_PW}" \
  "bifrost-shim-secret:${SHIM_SECRET}" \
  "vk-opencode-default:${VK_STD}" \
  "vk-opencode-agy:${VK_AGY}"; do
  name="${pair%%:*}"
  val="${pair#*:}"
  printf '%s' "${val}" | gcloud secrets create "${name}" \
    --project="${GCP_PROJECT_ID}" \
    --replication-policy="automatic" \
    --data-file=-
  gcloud secrets add-iam-policy-binding "${name}" \
    --project="${GCP_PROJECT_ID}" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/secretmanager.secretAccessor" >/dev/null
done

cat <<EOF

=========================================================================
SAVE THESE KEYS:
  [Admin Only] Bifrost UI Login      : admin / ${ADMIN_PW}
  [Share w/ Devs] Standard VK        : ${VK_STD}
  [Share w/ Devs] /agy Virtual Key   : ${VK_AGY}
=========================================================================
EOF
```

### Step 2: Deploy the External Stateless [`agy-receipt-echo`](../receipt-echo-service/README.md) Service

*(Since `bifrost-shim-secret` was already created in Step 1 above, skip Step 1 of `deploy/receipt-echo-service/README.md` and run its `gcloud builds submit` + `gcloud run deploy agy-receipt-echo --service-account="${SA_EMAIL}" ...` directly.)* Note the resulting `https://agy-receipt-echo-<HASH>-uc.a.run.app` URL.

### Step 3: Stage `bifrost-http` & `config.template.json` and Deploy Stock `bifrost-central`

1. Copy your unmodified Linux `x86_64` `bifrost-http` binary into `deploy/cloudrun/bifrost-http`.
2. Copy [`../../examples/bifrost.config.example.json`](../../examples/bifrost.config.example.json) into `deploy/cloudrun/config.template.json` and set `providers["agy-cli"].network_config.base_url` to your `https://agy-receipt-echo-<HASH>-uc.a.run.app` URL (`"allow_private_network": false`). *(Keep `"__VK_OPENCODE_DEFAULT__"` and `"__VK_OPENCODE_AGY__"` as-is—`entrypoint.sh` substitutes them from Secret Manager at container startup).*
3. Build and deploy:

```bash
export IMAGE_URI="${REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/bifrost-repo/bifrost-central:stock"

gcloud builds submit deploy/cloudrun \
  --project="${GCP_PROJECT_ID}" \
  --region="${REGION}" \
  --tag="${IMAGE_URI}"

gcloud run deploy bifrost-central \
  --project="${GCP_PROJECT_ID}" \
  --region="${REGION}" \
  --image="${IMAGE_URI}" \
  --service-account="${SA_EMAIL}" \
  --allow-unauthenticated \
  --min-instances=1 \
  --max-instances=1 \
  --concurrency=80 \
  --cpu=1 \
  --memory=1Gi \
  --port=8080 \
  --set-secrets="BIFROST_ADMIN_PASSWORD=bifrost-admin-pw:latest,SHIM_SHARED_SECRET=bifrost-shim-secret:latest,VK_OPENCODE_DEFAULT=vk-opencode-default:latest,VK_OPENCODE_AGY=vk-opencode-agy:latest" \
  --set-env-vars="VERTEX_PROJECT_ID=${GCP_PROJECT_ID}"
```

> [!NOTE]
> **Why `--min-instances=1 --max-instances=1`?** When using Bifrost's built-in SQLite `logs.db`, pinning a warm single instance (`concurrency=80`) keeps all dashboard analytics, token histograms, and rankings unified in one database. For multi-instance horizontal auto-scaling in production, configure Bifrost with PostgreSQL.
