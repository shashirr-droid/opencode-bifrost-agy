# `opencode-bifrost-agy`

**Zero-daemon, zero-dependency OpenCode V2 & V1 plugin integrating the [Bifrost AI Gateway](https://github.com/maximhq/bifrost) (Cloud Run / GKE or localhost), Google Antigravity CLI (`agy`), and Google Cloud Gemini Enterprise seats.**

![Split-Plane Architecture: OpenCode + Central Bifrost (Cloud Run) + Antigravity CLI & Gemini Enterprise](docs/images/system_architecture.jpg)

---

## Overview

`opencode-bifrost-agy` (`v2.0.6`) collapses the multi-service workstation glue between **OpenCode** (`v2.x` and `v1.18.29+`), **Bifrost AI Gateway** (central remote HTTPS on Cloud Run / GKE or local loopback), **Antigravity CLI (`agy`)**, and **Gemini Enterprise** into a **single in-process OpenCode plugin**:

- **Native OpenCode V2 + V1 Dual Contract:** Exports OpenCode V2's `{ id: "opencode-bifrost-agy", setup(ctx) }` alongside V1's `server()` hook with **zero runtime npm dependencies**—supporting both OpenCode V2 (`opencode plugin add`) and OpenCode V1 (`1.19.x`) from one package.
- **Zero Workstation Daemons & Zero Inbound Ports:** Runs natively inside OpenCode's Bun runtime (`Bun.serve` auto-unref'd and cleaned up on plugin unload)—eliminating external workstation `systemd`/`launchd` daemons and working seamlessly from developer laptops/VMs behind NAT.
- **Centralized Bifrost Policy Governance & Custom Model Aliases:** Standard prompts use your default Bifrost Virtual Key (`vkDefault` &rarr; Vertex AI / Anthropic / OpenAI), while `/agy` prompts enforce Bifrost's `/agy` Virtual Key (`vkAgy`), full `agy` model allowlists, custom `modelAliases`, and provider-scoped **CEL routing rules** (`policy-routed`, `agy-fast`, `agy-frontier`, `agy-pro`).
- **Live Central Bifrost Dashboard Telemetry (Zero Changes Inside Central Bifrost):** After each local `agy` turn finishes in `central-bifrost` mode, the plugin submits an outbound HTTPS **Empirical Telemetry Receipt** to your **100% stock, unmodified Central Bifrost**, whose `agy-cli` Custom Provider `base_url` points to the standalone stateless [`deploy/receipt-echo-service/`](deploy/receipt-echo-service/README.md)—populating Bifrost's **Provider Usage**, **Token Usage**, **Model Rankings**, **Virtual Key Rankings**, and **Logs** tabs with exact empirical tokens and zero inbound workstation ports.
- **Per-User Gemini Enterprise Seat & Metrics Attribution:** Strips Pay-As-You-Go API key overrides and runs `agy` locally under the developer's human `authorized_user` Application Default Credentials (`AGY_ADC_AUTH=true`) with `BAICODE_USER_TIER` telemetry enabled for **Gemini Enterprise > Developer tools metrics**.
- **15-Minute Implicit Cache Continuity (`--conversation <id>`):** Maintains a bounded 900-second session prefix map so follow-up prompts and tool continuations reuse the active `agy` `conversation_id`, maximizing Google Cloud's 5–15 minute implicit cache hits (`cache_read_tokens`).
- **Dynamic Workspace Binding & Native OpenCode Permissions:** Automatically scopes `agy` (`cwd` + `--add-dir`) to your active OpenCode repository and translates gated `agy` actions (`run_command`, outside-repo `read_file`, or `strict` `write_file`) into OpenAI `tool_calls` (`bash`, `read`, `write`) so OpenCode displays its native **`Allow once` / `Always allow` / `Reject`** prompt.

---

## 60-Second Quickstart (OpenCode V2)

```bash
# 1. One-time workstation prerequisites: Antigravity CLI + Human Gemini Enterprise ADC
curl -fsSL https://antigravity.google/cli/install.sh | bash
gcloud auth application-default login --project="<YOUR_GEMINI_ENTERPRISE_GCP_PROJECT_ID>"

# 2. Install the plugin globally in OpenCode V2
opencode plugin add github:shashirr-droid/opencode-bifrost-agy

# 3. Connect Central (or Local) Bifrost URL, Virtual Keys & Gemini Enterprise tier interactively
opencode auth login bifrost-agy
# (Or run `/connect` inside the OpenCode TUI and select "Antigravity CLI (Bifrost Policy + Gemini Enterprise)")

# 4. Verify readiness and start coding in any repository
cd ~/your-project
opencode plugin list
opencode
```

*(Using OpenCode V1 `1.19.x`? Install via `opencode plugin github:shashirr-droid/opencode-bifrost-agy -g` and run `opencode auth login`.)*

> [!TIP]
> **Which Security Keys Do I Need? (Developer vs. Gateway Admin)**
> - **Developers (Per Workstation — Zero Key Generation):** You do **not** generate any secrets. Run `gcloud auth application-default login` once (for your personal Gemini Enterprise seat) and paste the **`/agy` Virtual Key (`sk-bf-agy-...`)**—plus optional **Standard Virtual Key (`sk-bf-std-...`)**—issued by your Bifrost Admin when prompted by `opencode auth login bifrost-agy`.
> - **Bifrost Gateway Admins (One-Time Setup):** Create Virtual Keys in **1 click** inside the Bifrost Web UI (**Governance &rarr; Virtual Keys &rarr; + Create Virtual Key**) or auto-generate all gateway secrets in one copy-paste command—see **[Step 3: Create Security Keys & Configure Bifrost](docs/INSTALLATION_AND_CONFIGURATION.md#4-step-3-create-security-keys--configure-bifrost-admin-one-time)**.

Inside OpenCode:
- **Normal prompt (`Enter`):** Uses your standard Bifrost model (`vertex/*`, `anthropic/*`) with zero `agy` seat usage.
- **`/agy <task>`:** Switches to the `agy` agent and executes via Antigravity CLI under Bifrost's active `policy-routed` model policy.
- **`/agy-fast <task>` | `/agy-frontier <task>` | `/agy-pro <task>`:** Executes using Bifrost's configured model aliases (plus any custom entries in `modelAliases`).
- **`/agy-doctor`:** Runs an instant diagnostic check across `agy`, human ADC (`authorized_user`), `BAICODE_USER_TIER`, and Bifrost Virtual Key RBAC.

---

## Documentation & Deployment Bundles

| Document / Folder | Contents |
| :--- | :--- |
| **[Installation & Configuration Guide](docs/INSTALLATION_AND_CONFIGURATION.md)** | Step-by-step setup across **Google Cloud Gemini Enterprise**, **Antigravity CLI (`agy`)**, **Simplified 1-Click / 1-Command Security Key Setup**, **100% Stock Bifrost AI Gateway**, **OpenCode V2 & V1 Plugin**, and **Troubleshooting**. |
| **[Architecture & Request / Telemetry Data Flows](docs/ARCHITECTURE_AND_DATA_FLOW.md)** | Split-plane trust boundaries (`central-bifrost` vs. `through-bifrost`), **Standard Request Flow**, the 6-stage **Agentic `/agy` Coding Task Flow**, and how **unmodified Central Bifrost** records remote workstation `agy` telemetry via an external stateless `base_url`. |
| **[Stateless Receipt Echo Service (`deploy/receipt-echo-service/`)](deploy/receipt-echo-service/README.md)** | Standalone ~100-line stateless Cloud Run function (`agy-receipt-echo`) with copy-paste Secret Manager setup so **Central Bifrost requires zero custom code or sidecars**. |
| **[Stock Central Bifrost Cloud Run Bundle (`deploy/cloudrun/`)](deploy/cloudrun/README.md)** | Pure stock `bifrost-http` `Dockerfile`, `entrypoint.sh`, and one-shot Secret Manager key generator for Google Cloud Run. |
| **[Example Config Templates (`examples/`)](examples/)** | Sanitized ready-to-adapt templates: [`bifrost.env.example`](examples/bifrost.env.example), [`bifrost.config.example.json`](examples/bifrost.config.example.json), and [`opencode.json.example`](examples/opencode.json.example). |

---

## License

Apache-2.0 — see [LICENSE](LICENSE).
