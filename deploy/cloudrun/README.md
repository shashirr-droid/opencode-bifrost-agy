# Deploying 100% Stock Central Bifrost on Google Cloud Run (`central-bifrost` Mode)

This folder provides a **100% unmodified OSS `bifrost-http` container bundle** (zero sidecars, zero Python runtime, zero custom code inside Bifrost) for hosting the **Bifrost AI Gateway** centrally on **Google Cloud Run** while developers run **OpenCode** + **`opencode-bifrost-agy` (`v2.0.6+`)** + **Antigravity CLI (`agy`)** on remote laptops or VMs behind NAT.

To populate Central Bifrost's **Dashboard Analytics** (`Provider Usage`, `Token Usage`, `Model Rankings`, `Virtual Key Rankings`, `Logs`) without touching or customizing Central Bifrost itself, deploy the standalone stateless [**`deploy/receipt-echo-service/`**](../receipt-echo-service/README.md) on Cloud Run and set `providers["agy-cli"].network_config.base_url` to its HTTPS URL (`"allow_private_network": false`).

*(If you prefer a single-container deployment instead of a separate Cloud Run function, an optional co-located `receipt_bridge.py` reference is also retained in this directory).*

---

## Files Included

| File | Purpose |
| :--- | :--- |
| [`Dockerfile`](Dockerfile) | Minimal `debian:bookworm-slim` runtime packaging **only** unmodified `bifrost-http` (`:8080`) + `ca-certificates`. |
| [`entrypoint.sh`](entrypoint.sh) | Renders `/tmp/bifrost-data/config.json` with `0600` permissions and `exec`s stock `bifrost-http`. |
| [`receipt_bridge.py`](receipt_bridge.py) | *(Optional alternative)* Loopback receipt handler if you choose to co-locate on `127.0.0.1:8091` instead of using the external [`deploy/receipt-echo-service/`](../receipt-echo-service/README.md). |

---

## Quick Deployment Steps (Zero Custom Code in Central Bifrost)

1. **Deploy the external stateless [`agy-receipt-echo`](../receipt-echo-service/README.md) service first** and note its HTTPS URL (`https://agy-receipt-echo-<HASH>-uc.a.run.app`).

2. **Stage `bifrost-http` and `config.template.json`:**
   - Copy your unmodified Linux `x86_64` `bifrost-http` binary into `deploy/cloudrun/bifrost-http`.
   - Adapt [`../../examples/bifrost.config.example.json`](../../examples/bifrost.config.example.json) into `deploy/cloudrun/config.template.json`, setting `providers["agy-cli"].network_config` to `"base_url": "https://agy-receipt-echo-<HASH>-uc.a.run.app"` and `"allow_private_network": false`.

3. **Build & Deploy Stock Central Bifrost to Cloud Run:**
   ```bash
   export GCP_PROJECT_ID="<YOUR_GCP_PROJECT_ID>"
   export REGION="us-central1"
   export IMAGE_URI="${REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/bifrost-repo/bifrost-central:stock"

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
     --set-secrets="BIFROST_ADMIN_PASSWORD=bifrost-admin-pw:latest,SHIM_SHARED_SECRET=bifrost-shim-secret:latest,VK_OPENCODE_DEFAULT=vk-opencode-default:latest,VK_OPENCODE_AGY=vk-opencode-agy:latest" \
     --set-env-vars="VERTEX_PROJECT_ID=${GCP_PROJECT_ID}"
   ```

   > [!TIP]
   > **Already running an existing Central Bifrost deployment on GKE, ECS, or VMs?** You don't even need this `Dockerfile`—simply deploy [`deploy/receipt-echo-service/`](../receipt-echo-service/README.md) and paste its HTTPS URL into the **Custom Provider (`agy-cli`) -> Base URL** field in your existing Bifrost Admin UI!
