# Standalone Stateless Receipt Echo Service (`agy-receipt-echo`)

Deploy this **~100-line, zero-dependency, completely stateless HTTP service** on Cloud Run (or any serverless function platform) so your **Central Bifrost AI Gateway remains 100% stock and unmodified**—requiring zero custom sidecars, zero Python runtime inside the Bifrost container, and zero code changes to Bifrost itself.

---

## Why Use an External Receipt Echo `base_url`?

Open-source Bifrost (`bifrost-http`) does not expose a client-push `POST /api/logs` telemetry API; its `logstore` records token usage, model rankings, Virtual Key attribution, and routing rules strictly when a Custom Provider's configured `base_url` returns an OpenAI `chat.completion` JSON envelope.

By pointing your unmodified Central Bifrost's `providers["agy-cli"].network_config.base_url` to this external HTTPS service (`"allow_private_network": false`):
1. **Central Bifrost stays 100% stock** (official upstream binary/container, configured purely via standard Bifrost UI or `config.json`).
2. **Bearer Secret Authentication (`HTTP 401`):** Only requests from Central Bifrost carrying `Authorization: Bearer <RECEIPT_SHARED_SECRET>` are accepted.
3. **Catalog Delegation (`GET /v1/models` &rarr; `HTTP 501`):** Tells stock Central Bifrost to serve its own configured `providers["agy-cli"].keys[0].models` catalog without storing any model lists inside the echo service.
4. **Direct Non-Receipt Protection (`HTTP 502`):** Any direct call to `POST /v1/chat/completions` without an `AGY_EMPIRICAL_RECEIPT_V1:` payload is rejected with `HTTP 502 WorkstationExecutionRequired`.
5. **Exact Empirical Token Accounting (`HTTP 200`):** Echoes the workstation's verbatim `agy` token receipt (`prompt_tokens`, `completion_tokens`, `cached_tokens`, `reasoning_tokens`, `resolved_model`) so Central Bifrost's **Provider Usage**, **Token Usage**, **Model Rankings**, **Virtual Key Rankings**, and **Logs** stay 100% accurate with `total_cost: $0.00`.

---

## Step-by-Step Setup (Copy-Paste)

### Step 1: Generate the Shared Receipt Secret (1 Command)

This internal secret authenticates Central Bifrost when calling `agy-receipt-echo` (developers **never** need or see this secret):

```bash
export GCP_PROJECT_ID="<YOUR_GCP_PROJECT_ID>"
export REGION="us-central1"

# Auto-generate a 48-character random secret and store it in Google Cloud Secret Manager
SHIM_SECRET="$(openssl rand -hex 24)"
printf '%s' "${SHIM_SECRET}" | gcloud secrets create bifrost-shim-secret \
  --project="${GCP_PROJECT_ID}" \
  --replication-policy="automatic" \
  --data-file=-

# Allow the default Cloud Run runtime service account (or your custom SA) to read the secret
PROJECT_NUMBER="$(gcloud projects describe "${GCP_PROJECT_ID}" --format='value(projectNumber)')"
gcloud secrets add-iam-policy-binding bifrost-shim-secret \
  --project="${GCP_PROJECT_ID}" \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

echo "Paste this API Key into Central Bifrost Custom Provider (agy-cli): ${SHIM_SECRET}"
```

### Step 2: Build & Deploy `agy-receipt-echo` to Cloud Run

```bash
export ECHO_IMAGE="${REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/bifrost-repo/agy-receipt-echo:v1"

gcloud builds submit deploy/receipt-echo-service \
  --project="${GCP_PROJECT_ID}" \
  --region="${REGION}" \
  --tag="${ECHO_IMAGE}"

gcloud run deploy agy-receipt-echo \
  --project="${GCP_PROJECT_ID}" \
  --region="${REGION}" \
  --image="${ECHO_IMAGE}" \
  --allow-unauthenticated \
  --min-instances=0 \
  --max-instances=2 \
  --cpu=1 \
  --memory=256Mi \
  --port=8080 \
  --set-secrets="RECEIPT_SHARED_SECRET=bifrost-shim-secret:latest"
```

### Step 3: Connect Your Unmodified Central Bifrost & Create Developer Virtual Key

In your **Central Bifrost Web UI** (no container rebuild required):
1. Go to **Providers &rarr; + Add Custom Provider**:
   - **Provider Name:** `agy-cli` (`Base Provider Type: OpenAI`)
   - **Base URL:** `https://agy-receipt-echo-<HASH>-uc.a.run.app` *(leave `Allow Private Network` **OFF**)*
   - **API Key:** paste `${SHIM_SECRET}` from Step 1 (or set `"value": "env.SHIM_SHARED_SECRET"` if using `config.json`)
   - **Models:** add `policy-routed`, `agy-default`, `agy-fast`, `agy-frontier`, `agy-pro`, plus your approved `agy` model slugs.
2. Go to **Governance &rarr; Virtual Keys &rarr; + Create Virtual Key**:
   - Name it **`vk-opencode-agy`**, select provider **`agy-cli`**, click **Create**, and share the generated `sk-bf-...` Virtual Key with your developers for `opencode auth login bifrost-agy`.
