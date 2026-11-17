# Standalone Stateless Receipt Echo Service (`agy-receipt-echo`)

Deploy this **~100-line, zero-dependency, completely stateless HTTP service** on Cloud Run (or any serverless function platform) so your **Central Bifrost AI Gateway remains 100% stock and unmodified**—requiring zero custom sidecars, zero Python runtime inside the Bifrost container, and zero code changes to Bifrost itself.

---

## Why Use an External Receipt Echo `base_url`?

Open-source Bifrost (`bifrost-http`) does not expose a client-push `POST /api/logs` telemetry API; its `logstore` records token usage, model rankings, Virtual Key attribution, and routing rules strictly when a Custom Provider's configured `base_url` returns an OpenAI `chat.completion` JSON envelope.

By pointing your unmodified Central Bifrost's `providers["agy-cli"].network_config.base_url` to this external HTTPS service (`"allow_private_network": false`):
1. **Central Bifrost stays 100% stock** (official upstream binary/container, configured purely via standard Bifrost UI or `config.json`).
2. **Bearer Secret Authentication:** Only requests from Central Bifrost carrying `Authorization: Bearer <RECEIPT_SHARED_SECRET>` (configured as the `agy-cli` provider API Key in Bifrost) are accepted (`HTTP 401` otherwise).
3. **Catalog Delegation (`GET /v1/models` -> `HTTP 501`):** Tells stock Central Bifrost to serve its own configured `providers["agy-cli"].keys[0].models` catalog without storing any model lists inside the echo service.
4. **Direct Non-Receipt Protection (`HTTP 502`):** Any direct call to `POST /v1/chat/completions` without an `AGY_EMPIRICAL_RECEIPT_V1:` payload is rejected with `HTTP 502 WorkstationExecutionRequired`.
5. **Exact Empirical Token Accounting (`HTTP 200`):** Echoes the workstation's verbatim `agy` token receipt (`prompt_tokens`, `completion_tokens`, `cached_tokens`, `reasoning_tokens`, `resolved_model`) so Central Bifrost's **Provider Usage**, **Token Usage**, **Model Rankings**, **Virtual Key Rankings**, and **Logs** stay 100% accurate with `total_cost: $0.00`.

---

## Quick Deploy to Google Cloud Run

```bash
export GCP_PROJECT_ID="<YOUR_GCP_PROJECT_ID>"
export REGION="us-central1"
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

Then in your **unmodified Central Bifrost** UI (or `config.json`), set:
- **Custom Provider Name:** `agy-cli` (`base_provider_type: "openai"`)
- **Base URL:** `https://agy-receipt-echo-<HASH>-uc.a.run.app` (`"allow_private_network": false`)
- **API Key:** `env.SHIM_SHARED_SECRET` (matching `RECEIPT_SHARED_SECRET`)
