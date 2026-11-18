# End-to-End Installation & Configuration Guide

This guide walks platform administrators and developers through installing and configuring every layer of the **OpenCode + Bifrost AI Gateway + Antigravity CLI (`agy`) + Google Cloud Gemini Enterprise** stack—culminating in the single-entry **`opencode-bifrost-agy`** OpenCode plugin.

> [!IMPORTANT]
> **Security & Sanitization Note:** All values enclosed in `<ANGLE_BRACKETS>` are placeholders. Never commit Bifrost Virtual Keys, OAuth refresh tokens, or API keys to version control; store developer credentials in `~/.local/share/opencode/auth.json` (`0600`) via `opencode auth login` or root-protected environment files.

---

## Table of Contents

1. [Prerequisites Overview](#1-prerequisites-overview)
2. [Step 1: Configure Google Cloud & Gemini Enterprise](#2-step-1-configure-google-cloud--gemini-enterprise)
3. [Step 2: Install Antigravity CLI (`agy`) & Human User ADC](#3-step-2-install-antigravity-cli-agy--human-user-adc)
4. [Step 3: Create Security Keys & Configure Bifrost (Admin One-Time)](#4-step-3-create-security-keys--configure-bifrost-admin-one-time)
5. [Step 4: Install & Configure the `opencode-bifrost-agy` Plugin in OpenCode (Developer)](#5-step-4-install--configure-the-opencode-bifrost-agy-plugin-in-opencode-developer)
6. [Step 5: Requisite Parameters Reference](#6-step-5-requisite-parameters-reference)
7. [Step 6: Verification, Day-to-Day Usage & Day-2 Operations](#7-step-6-verification-day-to-day-usage--day-2-operations)
8. [Troubleshooting Runbook](#8-troubleshooting-runbook)

---

## 1. Prerequisites Overview

| Tier | Prerequisite | Owner |
| :--- | :--- | :--- |
| **Google Cloud / Gemini Enterprise** | A Google Cloud project with **Gemini Enterprise** enabled and human developer seats assigned (`Standard` or `Plus`). | Cloud / IAM Admin |
| **Bifrost AI Gateway** | OSS Bifrost AI Gateway running either centrally (`https://bifrost.example.internal`) or locally (`http://127.0.0.1:8080`). | Platform Admin |
| **Developer Workstation** | **OpenCode CLI** (`v2.x` recommended; `v1.18.29+` / `v1.19.x` also supported), **Google Cloud SDK (`gcloud`)**, and **Antigravity CLI (`agy` `v1.5.5+`)**. | Developer |

---

## 2. Step 1: Configure Google Cloud & Gemini Enterprise

### 2.1 Enable Required Google Cloud APIs & Seat IAM

Run the following commands against your organization's Gemini Enterprise Google Cloud project:

```bash
export GCP_PROJECT_ID="<YOUR_GEMINI_ENTERPRISE_GCP_PROJECT_ID>"
export DEVELOPER_EMAIL="<DEVELOPER_USER@YOUR_DOMAIN.EXAMPLE>"

# 1. Enable Gemini Enterprise & AI Companion APIs
gcloud services enable \
  aiplatform.googleapis.com \
  businessaicode.googleapis.com \
  cloudaicompanion.googleapis.com \
  discoveryengine.googleapis.com \
  --project="${GCP_PROJECT_ID}"

# 2. Grant the licensed human user access to Gemini Enterprise
gcloud projects add-iam-policy-binding "${GCP_PROJECT_ID}" \
  --member="user:${DEVELOPER_EMAIL}" \
  --role="roles/discoveryengine.agentspaceUser"
```

Ensure the user is also assigned an active **Gemini Enterprise Standard** or **Gemini Enterprise Plus** license seat in the Google Cloud Console.

### 2.2 Align Gemini Enterprise Admin Controls (`Settings > AI developer tools`)

In the Google Cloud Console under **Gemini Enterprise > Settings > AI developer tools**:
- **Terminal command auto-execution policy:** Keep **`Require review`** *(Recommended)*. Unattended shell commands inside headless `agy` will be blocked server-side and automatically delegated by `opencode-bifrost-agy` to OpenCode's native `bash` permission prompt (`Allow once` / `Always allow` / `Reject`).
- **Outside of file access policy:**
  - Keep **`Always ask`** or **`Deny`** *(Recommended)* to confine `agy` strictly to the developer's active OpenCode project directory (`cwd`); any outside-repo file read will be surfaced to OpenCode for explicit user approval.
  - Set **`Allow`** only if developers routinely want `agy` to inspect shared directories outside their current Git repository without prompting.

---

## 3. Step 2: Install Antigravity CLI (`agy`) & Human User ADC

Because Gemini Enterprise seats belong to **individual human identities** rather than service accounts, each developer authenticates once on their workstation using `gcloud auth application-default login`:

```bash
export GCP_PROJECT_ID="<YOUR_GEMINI_ENTERPRISE_GCP_PROJECT_ID>"
export GEMINI_ENT_LOCATION="global"              # global | us | eu
export BAICODE_USER_TIER="gcp-ge-plus-tier"      # gcp-ge-plus-tier | gcp-ge-standard-tier

# 1. Authenticate human Application Default Credentials (must produce "type": "authorized_user")
gcloud auth application-default login --project="${GCP_PROJECT_ID}"
gcloud auth application-default set-quota-project "${GCP_PROJECT_ID}"

# 2. Enable ADC mode in Antigravity user config
mkdir -p "${HOME}/.gemini/config"
cat << 'EOF' > "${HOME}/.gemini/config/config.json"
{
  "userSettings": {
    "enableAdc": true
  }
}
EOF

# 3. Install Antigravity CLI and verify live Gemini Enterprise model discovery
curl -fsSL https://antigravity.google/cli/install.sh | bash
export PATH="${HOME}/.local/bin:${PATH}"

AGY_ADC_AUTH=true \
GOOGLE_CLOUD_PROJECT="${GCP_PROJECT_ID}" \
GOOGLE_CLOUD_QUOTA_PROJECT="${GCP_PROJECT_ID}" \
GOOGLE_CLOUD_LOCATION="${GEMINI_ENT_LOCATION}" \
BAICODE_USER_TIER="${BAICODE_USER_TIER}" \
  agy models
```

> [!NOTE]
> **Enabling Gemini Enterprise Developer Tools Metrics:** Setting `BAICODE_USER_TIER` to `gcp-ge-plus-tier` (Gemini Enterprise Plus) or `gcp-ge-standard-tier` (Gemini Enterprise Standard) enables `agy` to emit usage & tool telemetry (`SendTelemetry`) to the **Gemini Enterprise > Developer tools metrics** dashboard. Keep `AGY_USE_BAIC_FETCH_CONFIG` unset.

---

## 4. Step 3: Create Security Keys & Configure Bifrost (Admin One-Time)

Bifrost serves as the centralized policy control plane—enforcing **Virtual Key RBAC** (separating standard LLM access from `/agy` access), **model allowlists**, **tier aliases**, and **CEL routing rules** (`policy-routed`).

### 4.1 Security Keys At-a-Glance (Who Creates vs. Who Uses What?)

> [!IMPORTANT]
> **Developers DO NOT generate random secrets.** A Gateway Admin creates the infrastructure secrets once and issues only **Virtual Keys (`sk-bf-...`)** to developers.

| Key / Credential | Created By | Used By | Purpose | How to Create |
| :--- | :--- | :--- | :--- | :--- |
| **`vkAgy` (`sk-bf-agy-...`)** | Bifrost Admin *(once per team or user)* | **Developer** *(paste into `opencode auth login bifrost-agy`)* | Authorizes `/agy` models, CEL routing, and Dashboard telemetry in Bifrost. | **1 click** in Bifrost UI (**Governance &rarr; Virtual Keys**) *or* `sk-bf-agy-$(openssl rand -hex 16)` |
| **`vkDefault` (`sk-bf-std-...`)** *(Optional)* | Bifrost Admin *(once per team or user)* | **Developer** *(paste into `opencode auth login bifrost-agy`)* | Authorizes standard non-`/agy` prompts (`vertex/*`, `anthropic/*`) while blocking `/agy`. | **1 click** in Bifrost UI (**Governance &rarr; Virtual Keys**) *or* `sk-bf-std-$(openssl rand -hex 16)` |
| **Human GCP ADC** | **Developer** *(on own workstation)* | **Local `agy` CLI** | Authenticates personal Gemini Enterprise seat (`authorized_user`). | `gcloud auth application-default login` *(Step 2 above — no key file to copy)* |
| **`SHIM_SHARED_SECRET`** *(Admin Only)* | Bifrost Admin *(one-time)* | **Bifrost &harr; `agy-receipt-echo` only** *(never shared with developers)* | Authenticates Central Bifrost when forwarding receipts to `agy-receipt-echo` (or local `:8091`). | `openssl rand -hex 24` |
| **`BIFROST_ADMIN_PASSWORD`** *(Admin Only)* | Bifrost Admin *(one-time)* | **Bifrost Admin UI** *(never shared with developers)* | Protects Bifrost Web Dashboard (`https://.../`) & `/api/*` admin endpoints. | `openssl rand -base64 18` |

---

### 4.2 Choose One Key Setup Method

Pick **whichever single path** matches how you run Bifrost—no manual `<GENERATE_RANDOM_HEX>` editing required:

#### Path A (Simplest): Existing Central Bifrost Web UI (1-Click Virtual Keys, Zero Config Edits)

If you already run an unmodified Central Bifrost instance (on GKE, Cloud Run, ECS, or a VM):

1. **Deploy the external receipt echo service (1 secret):** Follow **[`deploy/receipt-echo-service/README.md`](../deploy/receipt-echo-service/README.md)**—its Step 1 generates `SHIM_SECRET="$(openssl rand -hex 24)"` and prints the value + `https://agy-receipt-echo-...` URL.
2. **Register the `agy-cli` Custom Provider in Bifrost UI:**
   - Open your Bifrost Dashboard &rarr; **Providers &rarr; + Add Custom Provider**.
   - **Name:** `agy-cli` | **Base Provider Type:** `OpenAI` | **Base URL:** `https://agy-receipt-echo-<HASH>-uc.a.run.app` *(leave `Allow Private Network` **OFF**)*.
   - **API Key:** Paste `${SHIM_SECRET}` from step 1.
   - **Models:** Add `policy-routed`, `agy-default`, `agy-fast`, `agy-frontier`, `agy-pro`, plus your organization's approved `agy` model slugs.
3. **Create Developer Virtual Keys in 1 Click:**
   - Go to **Governance &rarr; Virtual Keys &rarr; + Create Virtual Key**:
     - **Key 1 (`/agy` Key — Required):** Name `vk-opencode-agy` &rarr; allow provider **`agy-cli`** &rarr; click **Create** &rarr; copy the auto-generated `sk-bf-...` token.
     - **Key 2 (Standard Key — Optional):** Name `vk-opencode-default` &rarr; allow providers **`vertex` / `anthropic`** *(exclude `agy-cli`)* &rarr; click **Create** &rarr; copy the auto-generated `sk-bf-...` token.
4. **Hand Off to Developers:** Share **only** your Central Bifrost URL and the copied `sk-bf-...` Virtual Key(s) with developers for Step 4 below.

#### Path B: New Central Bifrost on Google Cloud Run (One Copy-Paste Secret Manager Script)

If deploying Central Bifrost from scratch on Google Cloud Run, run the **single copy-paste block in [`deploy/cloudrun/README.md` (Step 1)](../deploy/cloudrun/README.md#step-1-auto-generate-all-4-keys-in-google-cloud-secret-manager-one-copy-paste-block)**—it automatically generates `BIFROST_ADMIN_PASSWORD`, `SHIM_SHARED_SECRET`, `VK_OPENCODE_DEFAULT`, and `VK_OPENCODE_AGY` via `openssl`, stores them in Google Cloud Secret Manager, binds IAM permissions, and prints the two developer Virtual Keys on screen.

#### Path C: Local Workstation or Single-VM Bifrost (`/etc/bifrost/bifrost.env` One-Shot Generator)

If running Bifrost locally (`http://127.0.0.1:8080`) or on a Linux VM via `/etc/bifrost/bifrost.env`, run this single copy-paste block to auto-generate all keys and render `/etc/bifrost/config.json` with `0600` permissions:

```bash
export VERTEX_PROJECT_ID="<YOUR_VERTEX_GCP_PROJECT_ID>"

sudo install -d -m 0750 /etc/bifrost
ADMIN_PW="$(openssl rand -base64 18)"
SHIM_SECRET="$(openssl rand -hex 24)"
VK_STD="sk-bf-std-$(openssl rand -hex 16)"
VK_AGY="sk-bf-agy-$(openssl rand -hex 16)"

sudo tee /etc/bifrost/bifrost.env >/dev/null <<EOF
VERTEX_PROJECT_ID=${VERTEX_PROJECT_ID}
BIFROST_ADMIN_PASSWORD=${ADMIN_PW}
SHIM_SHARED_SECRET=${SHIM_SECRET}
VK_OPENCODE_DEFAULT=${VK_STD}
VK_OPENCODE_AGY=${VK_AGY}
EOF
sudo chmod 0600 /etc/bifrost/bifrost.env

# Substitute Virtual Keys into config.json (for local through-bifrost mode, set base_url to http://127.0.0.1:8091 & allow_private_network: true)
sed \
  -e "s|__VK_OPENCODE_DEFAULT__|${VK_STD}|g" \
  -e "s|__VK_OPENCODE_AGY__|${VK_AGY}|g" \
  examples/bifrost.config.example.json | sudo tee /etc/bifrost/config.json >/dev/null
sudo chmod 0600 /etc/bifrost/config.json

cat <<EOF

=========================================================================
KEYS GENERATED (/etc/bifrost/bifrost.env):
  [Admin Only] Bifrost UI Login      : admin / ${ADMIN_PW}
  [Local Mode] SHIM_SHARED_SECRET    : ${SHIM_SECRET}
  [Paste in OpenCode] Standard VK    : ${VK_STD}
  [Paste in OpenCode] /agy VK        : ${VK_AGY}
=========================================================================
EOF
```

---

### 4.3 Summary of What `bifrost.config.example.json` Configures

Whether configured via the Bifrost UI (Path A) or [`examples/bifrost.config.example.json`](../examples/bifrost.config.example.json) (Paths B & C):
1. **`providers.vertex` / `providers.anthropic`:** Upstream providers used for default day-to-day OpenCode turns (`vk-opencode-default`).
2. **`providers["agy-cli"]`:** Custom OpenAI-compatible provider cataloging your organization's approved `agy` CLI model slugs plus logical targets (`policy-routed`, `agy-frontier`, `agy-fast`, `agy-pro`).
   - *Enterprise Central Bifrost (`central-bifrost` mode — Zero Changes Inside Central Bifrost):* Set `"base_url": "https://agy-receipt-echo-<HASH>-uc.a.run.app"` and `"allow_private_network": false` (pointing to [`deploy/receipt-echo-service/`](../deploy/receipt-echo-service/README.md)). Central Bifrost **never** opens inbound connections to developer workstations; the workstation plugin queries `/v1/models` & `/api/routing/rules` outbound over HTTPS before spawning `agy` locally, then posts the verbatim empirical `agy` token receipt back so all Dashboard charts stay populated in real time.
   - *Local Workstation Bifrost (`through-bifrost` mode):* Set `"base_url": "http://127.0.0.1:8091"` with `"allow_private_network": true` (and export `SHIM_SHARED_SECRET` or pass `shimSharedSecret` if enforcing loopback bearer auth).
3. **`governance.virtual_keys`:** `vk-opencode-default` grants access **only** to standard providers (`vertex`, `anthropic`), while `vk-opencode-agy` grants scoped access to `agy-cli` and its approved model list.
4. **`governance.routing_rules` (`rule-agy-global-default-model`):** Evaluates `provider == "agy-cli" && (model == "policy-routed" || model == "agy-cli/policy-routed")` and rewrites it to your chosen default `agy` model (e.g., `gemini-2.5-flash` or `gemini-2.5-pro`). Always include `provider == "agy-cli"` (and `provider == "vertex"` on Vertex rules) so shared model slugs never collide across providers.

---

## 5. Step 4: Install & Configure the `opencode-bifrost-agy` Plugin in OpenCode (Developer)

The `opencode-bifrost-agy` plugin (`v2.0.6`) exports both OpenCode V2's `{ id: "opencode-bifrost-agy", setup(ctx) }` contract and OpenCode V1's `server()` hook, running **in-process inside OpenCode's Bun runtime** with zero external daemons and zero runtime npm dependencies.

### Option A: One-Command Install + Interactive Login (`opencode plugin add` + `/connect`)

Have the **Bifrost Gateway URL** and the **`/agy` Virtual Key (`sk-bf-agy-...`)** (plus optional **Standard Virtual Key (`sk-bf-std-...`)**) from your Bifrost Admin handy, then run:

```bash
# 1. Install the plugin globally into OpenCode V2
opencode plugin add github:shashirr-droid/opencode-bifrost-agy

# (To upgrade an existing installation to the latest commit:)
# opencode plugin update opencode-bifrost-agy

# 2. Run the interactive credential & parameter setup wizard (CLI or `/connect` in TUI)
opencode auth login bifrost-agy
```

*(Using OpenCode V1 `1.19.x`? Run `opencode plugin github:shashirr-droid/opencode-bifrost-agy -g` followed by `opencode auth login`.)*

Enter the values when prompted by **`Antigravity CLI (Bifrost Policy + Gemini Enterprise)`** (`bifrost-agy`):
1. **Bifrost Gateway URL:** `https://bifrost.example.internal` *(or `http://127.0.0.1:8080` for local Bifrost)*
2. **Bifrost Standard Virtual Key (`vkDefault`):** Paste **`sk-bf-std-...`** *(optional — used for normal non-`/agy` coding turns)*
3. **Gemini Enterprise GCP Quota Project ID:** *(press `Enter` to accept the value auto-detected from your `application_default_credentials.json`)*
4. **Gemini Enterprise Location:** `global` | `us` | `eu`
5. **Gemini Enterprise License Tier:** `gcp-ge-plus-tier` | `gcp-ge-standard-tier`
6. **Headless Workspace Permission Posture:** `accept-edits` *(recommended)* | `strict`
7. **API Key (`/agy` Virtual Key — `vkAgy`):** Paste **`sk-bf-agy-...`** *(required — authorizes `/agy` models & telemetry)*

OpenCode V2 stores the credential and form metadata securely in its SQLite credential database (`~/.local/share/opencode/opencode.db`) and automatically reloads the `bifrost` and `bifrost-agy` model catalogs without restarting OpenCode.

### Option B: Declarative `opencode.jsonc` / `opencode.json` (MDM / Fleet Rollout)

For enterprise fleet distribution on **OpenCode V2**, place non-secret organization defaults under `"plugins"` in `~/.config/opencode/opencode.jsonc` or `~/.config/opencode/opencode.json` (see [`examples/opencode.json.example`](../examples/opencode.json.example)) while supplying Virtual Keys via `/connect`, `opencode auth login bifrost-agy`, or environment variables (`BIFROST_VK_DEFAULT`, `BIFROST_VK_AGY`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:shashirr-droid/opencode-bifrost-agy",
      "options": {
        "bifrostUrl": "https://bifrost.example.internal",
        "gcpLocation": "global",
        "baicodeUserTier": "gcp-ge-plus-tier",
        "permissionMode": "accept-edits"
      }
    }
  ]
}
```

*(If installing from a local clone on an air-gapped workstation, replace `"github:shashirr-droid/opencode-bifrost-agy"` with `"/absolute/path/to/opencode-bifrost-agy"`).*

---

## 6. Step 5: Requisite Parameters Reference

Parameters are resolved in priority order: **inline `opencode.json(c)` plugin `options`** &rarr; **saved OpenCode integration credential (`/connect` / `opencode auth login bifrost-agy`)** &rarr; **environment variables** &rarr; **auto-detected defaults**.

| Parameter | Env Fallback | Default / Auto-Detection | Description |
| :--- | :--- | :--- | :--- |
| **`bifrostUrl`** | `BIFROST_URL` | `http://127.0.0.1:8080` | Base URL of Central (`https://...`) or Local (`http://127.0.0.1:8080`) Bifrost Gateway. |
| **`vkAgy`** | `BIFROST_VK_AGY` | *(Required)* | Bifrost Virtual Key authorized for `agy-cli/*` models. |
| **`vkDefault`** | `BIFROST_VK_DEFAULT` | *(Optional)* | Bifrost Virtual Key for standard non-`agy` coding models (`vertex/*`, `anthropic/*`). |
| **`gcpProjectId`** | `GOOGLE_CLOUD_PROJECT` | Auto-read from `application_default_credentials.json` (`quota_project_id`) | Google Cloud project ID hosting the Gemini Enterprise entitlement. |
| **`gcpLocation`** | `GOOGLE_CLOUD_LOCATION` | `global` | Gemini Enterprise region (`global`, `us`, or `eu`). |
| **`baicodeUserTier`** | `BAICODE_USER_TIER` | `gcp-ge-plus-tier` | Seat tier (`gcp-ge-plus-tier` or `gcp-ge-standard-tier`) for **Developer tools metrics**. |
| **`permissionMode`** | `AGY_PERMISSION_MODE` | `accept-edits` | `accept-edits` allows file edits inside the active repo while delegating shell commands & outside reads to OpenCode; `strict` delegates file writes too. |
| **`routingMode`** | — | `auto` | `through-bifrost` when `bifrostUrl` is `localhost`/`127.0.0.1`; `central-bifrost` (ephemeral loopback port `0` + outbound HTTPS policy check) for remote URLs. |
| **`defaultAgyPolicyModel`** | `CENTRAL_DEFAULT_AGY_MODEL` | First discovered `agy` model | Fallback concrete `agy` model in `central-bifrost` mode when `/api/routing/rules` is not exposed to workstations. |
| **`modelAliases`** | — | `{}` | Optional map (`{ "agy-reasoning": "<AGY_MODEL_SLUG>" }`) registering additional selectable `/models` options and `/<alias>` slash commands in OpenCode. |
| **`bifrostPolicyUser` / `Password`** | `BIFROST_POLICY_USER` / `PASSWORD` | — | Optional read-only Basic Auth credentials to poll Central Bifrost `/api/routing/rules` in `central-bifrost` mode. |
| **`shimSharedSecret`** | `SHIM_SHARED_SECRET` | — | Optional shared token verified on `127.0.0.1:8091` when using local `through-bifrost` mode. |
| **`allowedWorkspaceRoots`** | `AGY_ALLOWED_WORKSPACE_ROOTS` | `[$HOME, <project_dir>, "/tmp"]` | Allowed directory prefixes where `agy` may bind `cwd` and `--add-dir`. |

---

## 7. Step 6: Verification, Day-to-Day Usage & Day-2 Operations

### 7.1 Run Pre-Flight Diagnostics

```bash
# Verify active plugin registration (must list `opencode-bifrost-agy`)
opencode plugin list

# Verify saved credentials
opencode auth list

# List dynamically discovered Bifrost + Gemini Enterprise agy models & aliases
opencode models
```

### 7.2 Interactive TUI Usage (`opencode`)

```bash
cd ~/your-repository
opencode
```

- **Type normally + `Enter`:** Uses your default Bifrost model (`bifrost/vertex/...`) with zero `agy` overhead.
- **`/agy <prompt>`:** Executes via Antigravity CLI using Bifrost's active `policy-routed` model, scoped to `~/your-repository`, preserving `conversation_id` across follow-ups for 15 minutes (GCP implicit cache), and surfacing interactive OpenCode permission prompts (`Allow once` / `Always allow` / `Reject`) for gated tools.
- **`/agy-frontier <prompt>` | `/agy-fast <prompt>` | `/agy-pro <prompt>`:** Routes via Bifrost's configured model aliases.
- **`/agy-doctor`:** Posts an instant readiness table auditing `agy`, human ADC (`authorized_user`), `BAICODE_USER_TIER`, and Bifrost connectivity directly into chat without consuming model tokens.

### 7.3 Central Day-2 Model Switching (Zero Workstation Changes)

To switch the active `/agy` model across every developer workstation, update `targets[0].model` on `rule-agy-global-default-model` in Bifrost (via the Bifrost UI or `PUT /api/routing/rules/rule-agy-global-default-model`). Workstations pick up the new model automatically with zero OpenCode config edits.

---

## 8. Troubleshooting Runbook

| Symptom | Root Cause | Resolution |
| :--- | :--- | :--- |
| **`Server plugin error: Plugin must export a default definition with an id and an effect or setup function`** | An earlier `v1.0.0` copy of the plugin is cached in OpenCode V2. | Run `opencode plugin update` (or `opencode plugin remove github:shashirr-droid/opencode-bifrost-agy && opencode plugin add github:shashirr-droid/opencode-bifrost-agy`) to pull `v2.0.0+`. |
| **`/agy-doctor` reports `adc_is_human_seat: false` or `403 PERMISSION_DENIED`** | Workstation ADC is missing or bound to a GCE service account instead of a licensed human user. | Run `gcloud auth application-default login --project="<YOUR_GCP_PROJECT_ID>"` as a user granted `roles/discoveryengine.agentspaceUser`. |
| **Usage does not appear in Gemini Enterprise > Developer tools metrics** | `baicodeUserTier` (`BAICODE_USER_TIER`) does not match the user's assigned license tier, or `AGY_USE_BAIC_FETCH_CONFIG=true` was set in the shell. | Set `baicodeUserTier` to `gcp-ge-plus-tier` or `gcp-ge-standard-tier`; the plugin automatically strips `AGY_USE_BAIC_FETCH_CONFIG` and PAYG keys. |
| **Bifrost returns `403 policy_model_blocked` or `401`** | The `vkAgy` Virtual Key has been revoked or its `allowed_models` list excludes the requested model. | Expected Bifrost RBAC behavior. Update `vk-opencode-agy` in Bifrost Governance or select an allowed model via `/models`. |
| **Local Bifrost cannot reach `127.0.0.1:8091` (`through-bifrost` mode)** | Bifrost SSRF protection blocks private/loopback IPs by default. | Ensure `"allow_private_network": true` is set under `providers["agy-cli"].network_config` in Bifrost `config.json`. |
