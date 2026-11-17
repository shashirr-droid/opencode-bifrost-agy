# Deploying Central Bifrost on Google Cloud Run (`central-bifrost` Mode)

This folder provides a ready-to-build container bundle for hosting the **Bifrost AI Gateway** centrally on **Google Cloud Run** while developers run **OpenCode** + **`opencode-bifrost-agy` (`v2.0.6+`)** + **Antigravity CLI (`agy`)** on remote laptops or VMs behind NAT (zero inbound workstation ports).

---

## Files Included

| File | Purpose |
| :--- | :--- |
| [`Dockerfile`](Dockerfile) | Minimal `debian:bookworm-slim` runtime packaging `bifrost-http` (`:8080`) + `receipt_bridge.py` (`127.0.0.1:8091`). |
| [`receipt_bridge.py`](receipt_bridge.py) | Container-internal (`127.0.0.1:8091`) **Empirical Telemetry Receipt Bridge**. Rejects direct non-receipt calls with `HTTP 502 WorkstationExecutionRequired` and relays verbatim workstation `agy` token receipts into Bifrost's Dashboard logstore. |
| [`entrypoint.sh`](entrypoint.sh) | Renders `/tmp/bifrost-data/config.json` with `0600` permissions, starts `receipt_bridge.py` on `127.0.0.1:8091`, and `exec`s `bifrost-http`. |

---

## Quick Deployment Steps

1. **Stage `bifrost-http` and `config.template.json`:**
   - Copy your Linux `x86_64` `bifrost-http` binary into `deploy/cloudrun/bifrost-http`.
   - Adapt [`../../examples/bifrost.config.example.json`](../../examples/bifrost.config.example.json) into `deploy/cloudrun/config.template.json` (using `__VK_OPENCODE_DEFAULT__` and `__VK_OPENCODE_AGY__` placeholders, and `"base_url": "http://127.0.0.1:8091"` with `"allow_private_network": true` so `bifrost-http` talks to the co-located `receipt_bridge.py` inside the container).

2. **Build & Deploy to Cloud Run:**
   ```bash
   export GCP_PROJECT_ID="<YOUR_GCP_PROJECT_ID>"
   export REGION="us-central1"
   export IMAGE_URI="${REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/bifrost-repo/bifrost-central:v1"

   gcloud builds submit deploy/cloudrun --project="${GCP_PROJECT_ID}" --region="${REGION}" --tag="${IMAGE_URI}"

   gcloud run deploy bifrost-central \
     --project="${GCP_PROJECT_ID}" \
     --region="${REGION}" \
     --image="${IMAGE_URI}" \
     --service-account="bifrost-central-sa@${GCP_PROJECT_ID}.iam.gserviceaccount.com" \
     --min-instances=1 \
     --max-instances=1 \
     --concurrency=80 \
     --cpu=1 \
     --memory=1Gi \
     --port=8080 \
     --set-secrets="BIFROST_ADMIN_PASSWORD=bifrost-admin-pw:latest,AGY_CATALOG_PLACEHOLDER_KEY=bifrost-shim-secret:latest,VK_OPENCODE_DEFAULT=vk-opencode-default:latest,VK_OPENCODE_AGY=vk-opencode-agy:latest" \
     --set-env-vars="VERTEX_PROJECT_ID=${GCP_PROJECT_ID}"
   ```

   > [!TIP]
   > **Why `--min-instances=1 --max-instances=1`?** When using Bifrost's built-in SQLite `logs.db`, pinning a warm single instance (`concurrency=80`) keeps all dashboard analytics, token histograms, and rankings unified in one database. For multi-instance horizontal auto-scaling in production, configure Bifrost with PostgreSQL or a shared volume.
