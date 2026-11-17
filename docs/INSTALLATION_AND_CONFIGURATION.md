# End-to-End Installation & Configuration Guide

This guide walks platform administrators and developers through installing and configuring every layer of the **OpenCode + Bifrost AI Gateway + Antigravity CLI (`agy`) + Google Cloud Gemini Enterprise** stack—culminating in the single-entry **`opencode-bifrost-agy`** OpenCode plugin.

> [!IMPORTANT]
> **Security & Sanitization Note:** All values enclosed in `<ANGLE_BRACKETS>` are placeholders. Never commit Bifrost Virtual Keys, OAuth refresh tokens, or API keys to version control; store developer credentials in `~/.local/share/opencode/auth.json` (`0600`) via `opencode auth login` or root-protected environment files.

---

## Table of Contents

1. [Prerequisites Overview](#1-prerequisites-overview)
2. [Step 1: Configure Google Cloud & Gemini Enterprise](#2-step-1-configure-google-cloud--gemini-enterprise)
3. [Step 2: Install Antigravity CLI (`agy`) & Human User ADC](#3-step-2-install-antigravity-cli-agy--human-user-adc)
4. [Step 3: Configure the Bifrost AI Gateway (Central or Local)](#4-step-3-configure-the-bifrost-ai-gateway-central-or-local)
5. [Step 4: Install & Configure the `opencode-bifrost-agy` Plugin in OpenCode](#5-step-4-install--configure-the-opencode-bifrost-agy-plugin-in-opencode)
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

## 4. Step 3: Configure the Bifrost AI Gateway (Central or Local)

Bifrost serves as the centralized policy control plane—enforcing **Virtual Key RBAC** (separating standard LLM access from `/agy` access), **model allowlists**, **tier aliases**, and **CEL routing rules** (`policy-routed`).

### 4.1 Create `/etc/bifrost/bifrost.env`

Copy [`examples/bifrost.env.example`](../examples/bifrost.env.example) to `/etc/bifrost/bifrost.env` (`chmod 0600`) and populate your Virtual Keys:

```ini
VERTEX_PROJECT_ID=<YOUR_VERTEX_GCP_PROJECT_ID>
ANTHROPIC_API_KEY=<YOUR_ANTHROPIC_API_KEY_OPTIONAL>
SHIM_SHARED_SECRET=<GENERATE_RANDOM_HEX_SECRET>

VK_OPENCODE_DEFAULT=sk-bf-std-<GENERATE_RANDOM_HEX_1>
VK_OPENCODE_AGY=sk-bf-agy-<GENERATE_RANDOM_HEX_2>
```

### 4.2 Merge Provider, Virtual Keys & CEL Rule into `config.json`

Merge [`examples/bifrost.config.example.json`](../examples/bifrost.config.example.json) into your Bifrost `config.json`:
1. **`providers.vertex` / `providers.anthropic`:** Upstream providers used for default day-to-day OpenCode turns (`vk-opencode-default`).
2. **`providers["agy-cli"]`:** Custom OpenAI-compatible provider cataloging your organization's approved `agy` CLI model slugs plus logical targets (`policy-routed`, `agy-frontier`, `agy-fast`, `agy-pro`).
   - *Local Workstation Bifrost (`through-bifrost` mode):* `base_url` (`http://127.0.0.1:8091/v1` with `"allow_private_network": true`) forwards `/agy` calls directly into the embedded listener inside the `opencode-bifrost-agy` plugin.
   - *Enterprise Central Bifrost (`central-bifrost` mode):* Central Bifrost never opens inbound connections to developer laptops; instead, the workstation plugin queries Central Bifrost's `GET /v1/models` and `/api/routing/rules` outbound over HTTPS to enforce Virtual Key allowlists and CEL rules before spawning `agy` locally.
3. **`governance.virtual_keys`:**
   - `vk-opencode-default`: Grants access **only** to standard providers (`vertex`, `anthropic`)—preventing default coding turns from invoking Antigravity.
   - `vk-opencode-agy`: Grants scoped access to `agy-cli` and its approved model list.
4. **`governance.routing_rules` (`rule-agy-global-default-model`):**
   - Evaluates `model == "policy-routed" || model == "agy-cli/policy-routed"` and rewrites it to your chosen default `agy` model (e.g., `gemini-2.5-flash` or `gemini-2.5-pro`).

---

## 5. Step 4: Install & Configure the `opencode-bifrost-agy` Plugin in OpenCode

The `opencode-bifrost-agy` plugin (`v2.0.0`) exports both OpenCode V2's `Plugin.define({ id: "opencode-bifrost-agy", setup(ctx) })` contract and OpenCode V1's `server()` hook, running **in-process inside OpenCode's Bun runtime** with zero external daemons.

### Option A: One-Command Install + Interactive Login (`opencode plugin add` + `/connect`)

```bash
# 1. Install the plugin globally into OpenCode V2
opencode plugin add github:shashirr-droid/opencode-bifrost-agy

# (To upgrade an existing installation to the latest commit:)
# opencode plugin update opencode-bifrost-agy

# 2. Run the interactive credential & parameter setup wizard (CLI or `/connect` in TUI)
opencode auth login bifrost-agy
```

*(Using OpenCode V1 `1.19.x`? Run `opencode plugin github:shashirr-droid/opencode-bifrost-agy -g` followed by `opencode auth login`.)*

Answer the form prompts when connecting **`Antigravity CLI (Bifrost Policy + Gemini Enterprise)`** (`bifrost-agy`):
1. **Bifrost Gateway URL:** `https://bifrost.example.internal` *(or `http://127.0.0.1:8080` for local Bifrost)*
2. **Bifrost Standard Virtual Key:** `sk-bf-std-...` *(optional, for default non-`/agy` coding turns)*
3. **Gemini Enterprise GCP Quota Project ID:** *(auto-suggested from your `application_default_credentials.json`)*
4. **Gemini Enterprise Location:** `global` | `us` | `eu`
5. **Gemini Enterprise License Tier:** `gcp-ge-plus-tier` | `gcp-ge-standard-tier`
6. **Headless Workspace Permission Posture:** `accept-edits` *(recommended)* | `strict`
7. **API Key (`/agy` Virtual Key):** `sk-bf-agy-...`

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
