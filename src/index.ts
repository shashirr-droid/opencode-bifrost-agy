import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Agent, Integration, Model, Plugin, Provider } from "@opencode/plugin";

const makeProviderID = (id: string) => id as Provider.ID;
const makeModelID = (id: string) => id as Model.ID;
const makeAgentID = (id: string) => id as Agent.ID;
const makeAgentName = (name: string) => name as Agent.Name;
const makeIntegrationID = (id: string) => id as Integration.ID;

function makeEmptyProviderInfo(id: Provider.ID): Provider.Info {
  return {
    id,
    name: id,
    activation: "auto",
    package: "",
  };
}

function makeDefaultModelInfo(providerID: Provider.ID, id: Model.ID): Model.Info {
  return {
    id,
    modelID: id,
    providerID,
    name: id,
    capabilities: {
      tools: true,
      input: ["text", "image"],
      output: ["text"],
    },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 200_000, output: 32_000 },
  };
}

function defineV2Plugin(plugin: Plugin.Plugin): Plugin.Plugin {
  return plugin;
}

export interface BifrostAgyPluginOptions {
  /** Base URL of Central or Local Bifrost Gateway (e.g. "https://bifrost.example.internal" or "http://127.0.0.1:8080") */
  bifrostUrl?: string;
  /** Routing topology: "auto" | "through-bifrost" (Bifrost -> plugin) | "central-bifrost" (OpenCode -> plugin -> Central Bifrost policy check + local agy) */
  routingMode?: "auto" | "through-bifrost" | "central-bifrost";
  /** Standard Bifrost Virtual Key (falls back to saved integration credential or env BIFROST_VK_DEFAULT) */
  vkDefault?: string;
  /** Bifrost Virtual Key authorized for /agy (falls back to saved integration credential or env BIFROST_VK_AGY) */
  vkAgy?: string;
  /** Optional Basic Auth user/password for reading Central Bifrost /api/routing/rules in central-bifrost mode */
  bifrostPolicyUser?: string;
  bifrostPolicyPassword?: string;
  /** Fallback concrete agy model slug when Central Bifrost rules API is not exposed to workstations */
  defaultAgyPolicyModel?: string;
  /** Optional map of custom slash-command / model alias slugs (e.g. "agy-reasoning") -> live agy model slug */
  modelAliases?: Record<string, string>;
  /** Default standard coding model in OpenCode (provider/model under bifrost) */
  defaultCodingModel?: string;
  /** Google Cloud Gemini Enterprise project ID (auto-detected from gcloud ADC quota_project_id if omitted) */
  gcpProjectId?: string;
  /** Gemini Enterprise location: "global" | "us" | "eu" */
  gcpLocation?: string;
  /** Gemini Enterprise seat tier for Developer tools metrics: "gcp-ge-plus-tier" | "gcp-ge-standard-tier" */
  baicodeUserTier?: string;
  /** Path to Antigravity CLI binary (auto-detected from ~/.local/bin/agy or PATH) */
  agyBin?: string;
  /** Headless agy permission posture: "accept-edits" (default) | "strict" */
  permissionMode?: "accept-edits" | "strict";
  /** Implicit cache conversation_id TTL in seconds (default 900 = 15 min) */
  conversationTtlSeconds?: number;
  /** Allowed workspace root prefixes */
  allowedWorkspaceRoots?: string[];
  /** Loopback port when routingMode is "through-bifrost" (default 8091) */
  localBridgePort?: number;
  /** Shared secret verified when local Bifrost proxies to localBridgePort */
  shimSharedSecret?: string;
}

interface SessionEntry {
  conversationId: string;
  workspaceDir: string;
  updatedAtMs: number;
  turnCount: number;
}

interface StoredLegacyAuthFile {
  [providerId: string]: {
    type?: string;
    key?: string;
    metadata?: Record<string, string>;
  };
}

interface ExternalCredentialOverrides {
  vkAgy?: string;
  vkDefault?: string;
  metadata?: Record<string, unknown>;
}

const PLUGIN_ID = "opencode-bifrost-agy";
const PLUGIN_VERSION = "2.0.3";
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;
const OPENCODE_ENV_CWD_RE = /<env>[\s\S]*?Working directory:\s*([^\r\n]+)[\s\S]*?<\/env>/;
const STRIPPED_AUTH_VARS = [
  "AGY_USE_BAIC_FETCH_CONFIG",
  "AGY_LLM_GATEWAY_URL",
  "AGY_LLM_GATEWAY_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
] as const;

function readAdcInfo(userHome: string): { type: string; quotaProjectId: string; path: string } {
  const adcPath =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    join(userHome, ".config", "gcloud", "application_default_credentials.json");
  if (!existsSync(adcPath)) {
    return { type: "missing", quotaProjectId: "", path: adcPath };
  }
  try {
    const parsed = JSON.parse(readFileSync(adcPath, "utf-8"));
    return {
      type: String(parsed.type || "unknown"),
      quotaProjectId: String(parsed.quota_project_id || ""),
      path: adcPath,
    };
  } catch {
    return { type: "invalid_json", quotaProjectId: "", path: adcPath };
  }
}

function readLegacyOpencodeAuth(userHome: string): StoredLegacyAuthFile {
  const authPath = join(userHome, ".local", "share", "opencode", "auth.json");
  if (!existsSync(authPath)) return {};
  try {
    return JSON.parse(readFileSync(authPath, "utf-8")) as StoredLegacyAuthFile;
  } catch {
    return {};
  }
}

function detectAgyBin(explicitBin?: string, userHome?: string): string {
  if (explicitBin && existsSync(explicitBin)) return explicitBin;
  const homeCandidate = join(userHome || homedir(), ".local", "bin", "agy");
  if (existsSync(homeCandidate)) return homeCandidate;
  if (existsSync("/usr/local/bin/agy")) return "/usr/local/bin/agy";
  return explicitBin || "agy";
}

function extractText(content: any): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          if ((item.type === "text" || item.type === "input_text") && typeof item.text === "string") {
            return item.text;
          }
          if ("content" in item) return extractText(item.content);
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return String(content);
}

function canonicalizeTurns(messages: any[]): Array<[string, string]> {
  const turns: Array<[string, string]> = [];
  for (const msg of messages || []) {
    const role = String(msg?.role || "user");
    if (role === "system" || role === "developer") continue;
    if (role === "assistant" && Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0) {
      const sig = msg.tool_calls.map((tc: any) => String(tc?.function?.name || "")).join("|");
      turns.push(["assistant_tc", sig]);
      continue;
    }
    if (role === "tool") {
      turns.push(["tool", extractText(msg?.content).trim()]);
      continue;
    }
    const txt = extractText(msg?.content).replace("[POLICY:AGY_AUTHORIZED]", "").trim();
    if (txt) turns.push([role, txt]);
  }
  return turns;
}

function hashPrefix(workspaceDir: string, turns: Array<[string, string]>): string {
  return createHash("sha256")
    .update(JSON.stringify({ cwd: workspaceDir, turns }))
    .digest("hex");
}

function strMeta(meta: Record<string, unknown> | undefined, key: string): string {
  const v = meta?.[key];
  return typeof v === "string" ? v.trim() : "";
}

function createBridgeRuntime(initialDirectory: string, rawOptions: Record<string, unknown> = {}) {
  const opts = (rawOptions || {}) as BifrostAgyPluginOptions;
  const userHome = homedir();
  const legacyAuth = readLegacyOpencodeAuth(userHome);
  const legacyMeta = legacyAuth["bifrost-agy"]?.metadata || {};

  let bifrostUrl = "";
  let gcpProjectId = "";
  let gcpLocation = "global";
  let baicodeUserTier = "gcp-ge-plus-tier";
  let permissionMode: "accept-edits" | "strict" = "accept-edits";
  let vkAgy = "";
  let vkDefault = "";
  let resolvedRoutingMode: "through-bifrost" | "central-bifrost" = "central-bifrost";

  const bifrostPolicyUser = String(opts.bifrostPolicyUser || process.env.BIFROST_POLICY_USER || "").trim();
  const bifrostPolicyPassword = String(opts.bifrostPolicyPassword || process.env.BIFROST_POLICY_PASSWORD || "").trim();
  const defaultAgyPolicyModel = String(opts.defaultAgyPolicyModel || process.env.CENTRAL_DEFAULT_AGY_MODEL || "").trim();
  const agyBin = detectAgyBin(opts.agyBin || process.env.AGY_BIN, userHome);
  const conversationTtlMs = Number(opts.conversationTtlSeconds || process.env.CONVERSATION_TTL_SECONDS || 900) * 1000;
  const shimSharedSecret = String(opts.shimSharedSecret || process.env.SHIM_SHARED_SECRET || "").trim();
  const localBridgePort = Number(opts.localBridgePort || 8091);

  const allowedRoots = (
    Array.isArray(opts.allowedWorkspaceRoots)
      ? opts.allowedWorkspaceRoots
      : process.env.AGY_ALLOWED_WORKSPACE_ROOTS
        ? process.env.AGY_ALLOWED_WORKSPACE_ROOTS.split(",")
        : [userHome, resolve(initialDirectory), "/tmp"]
  )
    .map((p) => String(p).trim())
    .filter(Boolean)
    .map((p) => resolve(p));

  const sessionMap = new Map<string, SessionEntry>();
  const auditRing: Array<Record<string, any>> = [];
  let modelCache: Record<string, string> = {};
  let modelCacheTs = 0;
  const vkAllowCache = new Map<string, { ts: number; allowed: Set<string> }>();
  let policyRulesCache: { ts: number; rules: any[] } = { ts: 0, rules: [] };
  let latestActiveOpencodeDir = resolve(initialDirectory);

  function applyCredentialOverrides(ext: ExternalCredentialOverrides = {}): void {
    const adcInfo = readAdcInfo(userHome);
    const meta = ext.metadata || {};

    bifrostUrl = String(
      opts.bifrostUrl ||
        strMeta(meta, "bifrostUrl") ||
        legacyMeta.bifrostUrl ||
        process.env.BIFROST_URL ||
        "http://127.0.0.1:8080"
    ).replace(/\/+$/, "");

    gcpProjectId = String(
      opts.gcpProjectId ||
        strMeta(meta, "gcpProjectId") ||
        legacyMeta.gcpProjectId ||
        process.env.GOOGLE_CLOUD_PROJECT ||
        process.env.GOOGLE_CLOUD_QUOTA_PROJECT ||
        adcInfo.quotaProjectId ||
        ""
    ).trim();

    gcpLocation = String(
      opts.gcpLocation ||
        strMeta(meta, "gcpLocation") ||
        legacyMeta.gcpLocation ||
        process.env.GOOGLE_CLOUD_LOCATION ||
        "global"
    ).trim();

    baicodeUserTier = String(
      opts.baicodeUserTier ||
        strMeta(meta, "baicodeUserTier") ||
        legacyMeta.baicodeUserTier ||
        process.env.BAICODE_USER_TIER ||
        "gcp-ge-plus-tier"
    ).trim();

    const rawPerm = String(
      opts.permissionMode ||
        strMeta(meta, "permissionMode") ||
        legacyMeta.permissionMode ||
        process.env.AGY_PERMISSION_MODE ||
        "accept-edits"
    ).trim();
    permissionMode = rawPerm === "strict" ? "strict" : "accept-edits";

    vkAgy = String(
      opts.vkAgy || ext.vkAgy || legacyAuth["bifrost-agy"]?.key || process.env.BIFROST_VK_AGY || ""
    ).trim();

    vkDefault = String(
      opts.vkDefault ||
        ext.vkDefault ||
        strMeta(meta, "vkDefault") ||
        legacyMeta.vkDefault ||
        legacyAuth["bifrost"]?.key ||
        process.env.BIFROST_VK_DEFAULT ||
        ""
    ).trim();

    const isLocalBifrost = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(bifrostUrl);
    resolvedRoutingMode =
      opts.routingMode === "through-bifrost" || opts.routingMode === "central-bifrost"
        ? opts.routingMode
        : isLocalBifrost
          ? "through-bifrost"
          : "central-bifrost";

    vkAllowCache.clear();
    policyRulesCache = { ts: 0, rules: [] };
  }

  applyCredentialOverrides();

  function buildAgyEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    for (const bad of STRIPPED_AUTH_VARS) {
      delete env[bad];
    }
    env.HOME = userHome;
    env.PATH = `${join(userHome, ".local", "bin")}:/usr/local/bin:/usr/bin:/bin:${env.PATH || ""}`;
    env.AGY_ADC_AUTH = "true";
    if (gcpProjectId) {
      env.GOOGLE_CLOUD_PROJECT = gcpProjectId;
      env.GOOGLE_CLOUD_QUOTA_PROJECT = gcpProjectId;
    }
    env.GOOGLE_CLOUD_LOCATION = gcpLocation;
    if (baicodeUserTier) {
      env.BAICODE_USER_TIER = baicodeUserTier;
    }
    return env;
  }

  function isAllowedWorkspace(candidate: string): boolean {
    const real = resolve(candidate);
    if (!existsSync(real)) return false;
    return allowedRoots.some((root) => real === root || real.startsWith(root.replace(/\/+$/, "") + "/"));
  }

  function resolveWorkspaceDir(req: Request, messages: any[]): { dir: string; source: string } {
    for (const hdr of ["x-opencode-workspace-dir", "x-agy-workspace-dir", "x-opencode-directory"]) {
      const raw = (req.headers.get(hdr) || "").trim();
      if (raw && isAllowedWorkspace(raw)) {
        return { dir: resolve(raw), source: `header:${hdr}` };
      }
    }
    for (const msg of messages || []) {
      if (msg?.role === "system" || msg?.role === "developer") {
        const m = OPENCODE_ENV_CWD_RE.exec(extractText(msg?.content));
        if (m?.[1] && isAllowedWorkspace(m[1].trim())) {
          return { dir: resolve(m[1].trim()), source: "opencode_env" };
        }
      }
    }
    if (isAllowedWorkspace(latestActiveOpencodeDir)) {
      return { dir: latestActiveOpencodeDir, source: "plugin_directory" };
    }
    return { dir: userHome, source: "user_home" };
  }

  function pruneSessions(): void {
    const now = Date.now();
    for (const [k, v] of sessionMap.entries()) {
      if (now - v.updatedAtMs > conversationTtlMs) {
        sessionMap.delete(k);
      }
    }
    while (sessionMap.size > 256) {
      const oldest = sessionMap.keys().next().value;
      if (!oldest) break;
      sessionMap.delete(oldest);
    }
  }

  function lookupSession(workspaceDir: string, turns: Array<[string, string]>): { entry: SessionEntry | null; deltaPrompt: string } {
    pruneSessions();
    if (turns.length < 2) return { entry: null, deltaPrompt: "" };
    const last = turns[turns.length - 1];
    if (last[0] === "tool") {
      let toolCount = 0;
      for (let i = turns.length - 1; i >= 0; i--) {
        if (turns[i][0] === "tool") toolCount++;
        else break;
      }
      const prefix = turns.slice(0, turns.length - toolCount);
      if (prefix.length > 0) {
        const hit = sessionMap.get(hashPrefix(workspaceDir, prefix));
        if (hit) {
          hit.updatedAtMs = Date.now();
          const joined = turns
            .slice(turns.length - toolCount)
            .map((t) => t[1])
            .join("\n\n");
          return {
            entry: hit,
            deltaPrompt:
              `The user reviewed the requested tool action in OpenCode. Result from OpenCode:\n\n${joined}\n\n` +
              `Continue responding to the user's request using this result without re-invoking the same tool action.`,
          };
        }
      }
    }
    if (last[0] === "user") {
      const hit = sessionMap.get(hashPrefix(workspaceDir, turns.slice(0, -1)));
      if (hit) {
        hit.updatedAtMs = Date.now();
        return { entry: hit, deltaPrompt: last[1] };
      }
    }
    return { entry: null, deltaPrompt: "" };
  }

  function storeSession(workspaceDir: string, turns: Array<[string, string]>, conversationId: string, turnCount: number): void {
    if (!conversationId || turns.length === 0) return;
    pruneSessions();
    sessionMap.set(hashPrefix(workspaceDir, turns), {
      conversationId,
      workspaceDir,
      updatedAtMs: Date.now(),
      turnCount,
    });
  }

  async function discoverAgyModels(forceRefresh = false): Promise<Record<string, string>> {
    const now = Date.now();
    if (!forceRefresh && Object.keys(modelCache).length > 0 && now - modelCacheTs < 60_000) {
      return { ...modelCache };
    }
    const proc = Bun.spawn([agyBin, "models"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: buildAgyEnv(),
    });
    const killTimer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }, 10_000);
    const [stdoutTxt, stderrTxt, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(killTimer);
    if (exitCode !== 0) {
      throw new Error(`\`agy models\` failed (exit ${exitCode}): ${stderrTxt.trim() || stdoutTxt.trim()}`);
    }
    const parsed: Record<string, string> = {};
    for (const rawLine of stdoutTxt.split(/\r?\n/)) {
      const clean = rawLine.replace(ANSI_RE, "").trim();
      if (!clean || clean.toLowerCase().startsWith("fetching ")) continue;
      const parts = clean.includes("\t") ? clean.split("\t") : clean.split(/\s{2,}/);
      if (parts.length >= 2) {
        const slug = parts[0].trim();
        const displayName = parts.slice(1).join(" ").trim();
        if (SLUG_RE.test(slug)) parsed[slug] = displayName;
      }
    }
    if (Object.keys(parsed).length === 0) {
      throw new Error(`\`agy models\` returned 0 parseable models: ${stdoutTxt}`);
    }
    modelCache = parsed;
    modelCacheTs = Date.now();
    return { ...modelCache };
  }

  async function validateCentralVirtualKey(vk: string): Promise<{ status: number; allowed: Set<string>; error: string }> {
    const now = Date.now();
    const cached = vkAllowCache.get(vk);
    if (cached && now - cached.ts < 60_000) {
      return { status: 200, allowed: new Set(cached.allowed), error: "" };
    }
    try {
      const resp = await fetch(`${bifrostUrl}/v1/models`, {
        headers: { Authorization: `Bearer ${vk}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!resp.ok) {
        return { status: resp.status, allowed: new Set(), error: await resp.text() };
      }
      const data = (await resp.json()) as { data?: Array<{ id?: string }> };
      const allowed = new Set<string>();
      for (const item of data.data || []) {
        const id = String(item?.id || "");
        if (id.startsWith("agy-cli/")) {
          allowed.add(id.slice("agy-cli/".length));
        }
      }
      vkAllowCache.set(vk, { ts: now, allowed });
      return { status: 200, allowed: new Set(allowed), error: "" };
    } catch (err: any) {
      return { status: 502, allowed: new Set(), error: String(err?.message || err) };
    }
  }

  async function fetchCentralRoutingRules(): Promise<any[]> {
    const now = Date.now();
    if (policyRulesCache.rules.length > 0 && now - policyRulesCache.ts < 5_000) {
      return policyRulesCache.rules;
    }
    if (!bifrostPolicyUser || !bifrostPolicyPassword) {
      return [];
    }
    try {
      const basic = Buffer.from(`${bifrostPolicyUser}:${bifrostPolicyPassword}`).toString("base64");
      const resp = await fetch(`${bifrostUrl}/api/routing/rules`, {
        headers: { Authorization: `Basic ${basic}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (resp.ok) {
        const raw: any = await resp.json();
        const rules: any[] = Array.isArray(raw) ? raw : raw?.rules || raw?.data || [];
        rules.sort((a: any, b: any) => Number(a?.priority ?? 100) - Number(b?.priority ?? 100));
        policyRulesCache = { ts: now, rules };
        return rules;
      }
    } catch {
      // Fall back to local modelAliases or defaultAgyPolicyModel
    }
    return [];
  }

  async function resolveCentralPolicyModel(requestedSlug: string, catalog: Record<string, string>): Promise<string> {
    const rules = await fetchCentralRoutingRules();
    for (const rule of rules) {
      if (rule?.enabled === false) continue;
      const expr = String(rule?.cel_expression || "");
      if (
        expr.includes(`"${requestedSlug}"`) ||
        expr.includes(`/${requestedSlug}"`) ||
        expr.includes(`'${requestedSlug}'`) ||
        expr.includes(`/${requestedSlug}'`)
      ) {
        const targetModel = String(rule?.targets?.[0]?.model || "").split("/").pop() || "";
        if (targetModel) {
          return targetModel;
        }
      }
    }
    if (requestedSlug === "policy-routed") {
      if (defaultAgyPolicyModel && catalog[defaultAgyPolicyModel]) {
        return defaultAgyPolicyModel;
      }
      const firstSlug = Object.keys(catalog)[0];
      if (!firstSlug) throw new Error("No models available in live `agy models` catalog.");
      return firstSlug;
    }
    return "";
  }

  function buildFullPrompt(messages: any[], hasClientTools: boolean): string {
    const sysParts: string[] = [];
    const convoTurns: Array<[string, string]> = [];
    for (const msg of messages || []) {
      const role = String(msg?.role || "user");
      const txt = extractText(msg?.content).replace("[POLICY:AGY_AUTHORIZED]", "").trim();
      if (!txt) continue;
      if (role === "system" || role === "developer") sysParts.push(txt);
      else if (role === "user") convoTurns.push(["User", txt]);
      else if (role === "assistant") convoTurns.push(["Assistant", txt]);
      else if (role === "tool") convoTurns.push(["Tool Output", txt]);
    }
    if (convoTurns.length === 0) return sysParts.join("\n\n") || "Hello";
    let corePrompt: string;
    if (convoTurns.length === 1 && convoTurns[0][0] === "User") {
      corePrompt = convoTurns[0][1];
    } else {
      const transcript = convoTurns
        .slice(0, -1)
        .map(([s, t]) => `[${s}]\n${t}`)
        .join("\n\n");
      const [latestSpeaker, latestText] = convoTurns[convoTurns.length - 1];
      corePrompt = `Prior conversation context:\n${transcript}\n\nCurrent ${latestSpeaker} request:\n${latestText}`;
    }
    if (!hasClientTools && sysParts.length > 0) {
      return `System instructions:\n${sysParts.join("\n\n")}\n\nUser request:\n${corePrompt}`;
    }
    return corePrompt;
  }

  async function extractDeniedWritePayload(
    conversationId: string,
    modelSlug: string,
    workspaceDir: string,
    fallbackPath: string
  ): Promise<{ filePath: string; content: string } | null> {
    if (!conversationId) return null;
    const proc = Bun.spawn(
      [
        agyBin,
        "-p",
        'Your previous write_file tool call required host permission in headless mode. Do NOT call any tools. Reply with ONLY a raw JSON object containing exact keys "filePath" and "content" for the file you intended to write, with no markdown fences.',
        "--conversation",
        conversationId,
        "--model",
        modelSlug,
        "--output-format",
        "stream-json",
        "--disable-slash-commands",
        "--add-dir",
        workspaceDir,
      ],
      { cwd: workspaceDir, stdout: "pipe", stderr: "pipe", env: buildAgyEnv() }
    );
    const [outTxt, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0) return null;
    for (const line of outTxt.split(/\r?\n/).reverse()) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const evt = JSON.parse(trimmed);
        if (evt?.event !== "result") continue;
        const resp = String(evt?.result?.response || "").trim();
        const s = resp.indexOf("{");
        const e = resp.lastIndexOf("}");
        if (s !== -1 && e > s) {
          const parsed = JSON.parse(resp.slice(s, e + 1));
          if (parsed && typeof parsed === "object" && "content" in parsed) {
            return {
              filePath: String(parsed.filePath || fallbackPath),
              content: String(parsed.content),
            };
          }
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  async function mapDeniedToolToOpencode(
    lastToolInfo: any,
    deniedActions: any[],
    clientTools: Set<string>,
    workspaceDir: string,
    conversationId: string,
    modelSlug: string
  ): Promise<any | null> {
    if (!deniedActions?.length || clientTools.size === 0) return null;
    const tname = String(lastToolInfo?.name || "");
    const params = lastToolInfo?.parameters || {};
    const callId = `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

    if (tname === "run_command" && clientTools.has("bash") && params.CommandLine) {
      return {
        id: callId,
        type: "function",
        function: {
          name: "bash",
          arguments: JSON.stringify({
            command: String(params.CommandLine).trim(),
            workdir: String(params.Cwd || workspaceDir),
          }),
        },
      };
    }
    if ((tname === "read_file" || tname === "view_file") && clientTools.has("read")) {
      const fpath = String(params.Path || params.AbsolutePath || "").trim();
      if (fpath) {
        return {
          id: callId,
          type: "function",
          function: { name: "read", arguments: JSON.stringify({ filePath: fpath }) },
        };
      }
    }
    if ((tname === "write_file" || tname === "write_to_file") && clientTools.has("write")) {
      const fpath = String(params.Path || params.TargetFile || "").trim();
      const directContent = params.CodeContent ?? params.Content;
      const payload =
        directContent !== undefined && fpath
          ? { filePath: fpath, content: String(directContent) }
          : await extractDeniedWritePayload(conversationId, modelSlug, workspaceDir, fpath);
      if (payload?.filePath) {
        return {
          id: callId,
          type: "function",
          function: { name: "write", arguments: JSON.stringify(payload) },
        };
      }
    }
    return null;
  }

  async function handleBridgeRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "GET" && path === "/healthz") {
      try {
        const catalog = await discoverAgyModels(url.searchParams.get("refresh") === "true");
        pruneSessions();
        return Response.json({
          status: "ok",
          runtime: "in-process-opencode-plugin",
          version: PLUGIN_VERSION,
          routing_mode: resolvedRoutingMode,
          bifrost_url: bifrostUrl,
          project: gcpProjectId,
          location: gcpLocation,
          baicode_user_tier: baicodeUserTier,
          permission_mode: permissionMode,
          active_cached_sessions: sessionMap.size,
          model_count: Object.keys(catalog).length,
          models: catalog,
        });
      } catch (err: any) {
        return Response.json({ status: "error", error: String(err?.message || err) }, { status: 503 });
      }
    }

    if (req.method === "GET" && path === "/audit/recent") {
      pruneSessions();
      return Response.json({
        runtime: "in-process-opencode-plugin",
        version: PLUGIN_VERSION,
        routing_mode: resolvedRoutingMode,
        active_cached_sessions: sessionMap.size,
        count: auditRing.length,
        entries: auditRing,
      });
    }

    if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
      try {
        const catalog = await discoverAgyModels(url.searchParams.get("refresh") === "true");
        const created = Math.floor(Date.now() / 1000);
        return Response.json({
          object: "list",
          data: Object.entries(catalog).map(([id, displayName]) => ({
            id,
            object: "model",
            created,
            owned_by: `opencode-plugin-agy-${gcpProjectId || "gemini-enterprise"}`,
            metadata: { display_name: displayName, license_mode: "gemini-enterprise-adc" },
          })),
        });
      } catch (err: any) {
        return Response.json({ error: { message: String(err?.message || err), type: "UpstreamAgyModelsError" } }, { status: 502 });
      }
    }

    if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
      const authHdr = req.headers.get("authorization") || "";
      const bearerToken = authHdr.toLowerCase().startsWith("bearer ") ? authHdr.slice(7).trim() : "";

      let body: any;
      try {
        body = await req.json();
      } catch (err: any) {
        return Response.json({ error: { message: `Invalid JSON: ${err}`, type: "InvalidRequestError" } }, { status: 400 });
      }

      let catalog = await discoverAgyModels(false);
      const rawModel = String(body?.model || "").trim();
      let requestedModel = rawModel.includes("/") ? rawModel.split("/").pop()! : rawModel;
      const configuredAliasTarget =
        opts.modelAliases && typeof opts.modelAliases[requestedModel] === "string"
          ? opts.modelAliases[requestedModel].trim()
          : "";

      if (resolvedRoutingMode === "through-bifrost") {
        if (shimSharedSecret && bearerToken !== shimSharedSecret && req.headers.get("x-api-key") !== shimSharedSecret) {
          return Response.json(
            { error: { message: "Unauthorized direct loopback call; route through Bifrost.", type: "PluginAuthError" } },
            { status: 401 }
          );
        }
        if (configuredAliasTarget) {
          requestedModel = configuredAliasTarget;
        }
      } else {
        const callerVk = bearerToken || vkAgy;
        if (!callerVk) {
          return Response.json(
            {
              error: {
                message: "Missing Bifrost Virtual Key. Run `/connect` (`opencode auth login bifrost-agy`) or set `BIFROST_VK_AGY`.",
                type: "PluginAuthError",
              },
            },
            { status: 401 }
          );
        }
        const vkCheck = await validateCentralVirtualKey(callerVk);
        if (vkCheck.status !== 200) {
          return Response.json(
            { error: { message: vkCheck.error || "Bifrost Virtual Key rejected.", type: "BifrostPolicyError" } },
            { status: vkCheck.status === 401 || vkCheck.status === 403 ? vkCheck.status : 502 }
          );
        }
        let targetSlug = requestedModel;
        if (requestedModel === "policy-routed" || !catalog[requestedModel]) {
          const centralTarget = await resolveCentralPolicyModel(requestedModel, catalog);
          targetSlug = centralTarget || configuredAliasTarget || requestedModel;
        }
        if (!vkCheck.allowed.has("*") && !vkCheck.allowed.has(targetSlug)) {
          return Response.json(
            { error: { message: `Model '${targetSlug}' denied by Central Bifrost Virtual Key policy.`, type: "BifrostPolicyError" } },
            { status: 403 }
          );
        }
        requestedModel = targetSlug;
      }

      if (!catalog[requestedModel]) {
        catalog = await discoverAgyModels(true);
      }
      if (!catalog[requestedModel]) {
        return Response.json(
          { error: { message: `Model '${requestedModel}' not found in live \`agy models\`.`, type: "ModelNotFoundError" } },
          { status: 400 }
        );
      }

      const messages = Array.isArray(body?.messages) ? body.messages : [];
      const stream = Boolean(body?.stream);
      const clientTools = new Set<string>(
        (Array.isArray(body?.tools) ? body.tools : [])
          .map((t: any) => String(t?.function?.name || ""))
          .filter(Boolean)
      );
      const { dir: workspaceDir, source: workspaceSource } = resolveWorkspaceDir(req, messages);
      const canonicalTurns = canonicalizeTurns(messages);
      const { entry: resumedEntry, deltaPrompt } = lookupSession(workspaceDir, canonicalTurns);
      const resumedConvoId = resumedEntry?.conversationId || null;
      const prompt = resumedEntry ? deltaPrompt : buildFullPrompt(messages, clientTools.size > 0);
      const reqPermMode = (req.headers.get("x-agy-permission-mode") || permissionMode).toLowerCase();

      const cmd = [
        agyBin,
        "-p",
        prompt,
        "--model",
        requestedModel,
        "--output-format",
        "stream-json",
        "--disable-slash-commands",
        "--add-dir",
        workspaceDir,
      ];
      if (resumedConvoId) cmd.push("--conversation", resumedConvoId);
      if (reqPermMode === "accept-edits") cmd.push("--mode", "accept-edits");

      const completionId = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      const created = Math.floor(Date.now() / 1000);
      const startedMs = Date.now();

      if (!stream) {
        const proc = Bun.spawn(cmd, { cwd: workspaceDir, stdout: "pipe", stderr: "pipe", env: buildAgyEnv() });
        const [stdoutTxt, stderrTxt, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        if (exitCode !== 0) {
          return Response.json(
            { error: { message: stderrTxt.trim() || stdoutTxt.trim(), type: "AgyCliExecutionError" } },
            { status: 502 }
          );
        }
        let convoId = resumedConvoId || "";
        let lastToolInfo: any = null;
        let resultObj: any = null;
        for (const rawLn of stdoutTxt.split(/\r?\n/)) {
          const ln = rawLn.trim();
          if (!ln.startsWith("{")) continue;
          try {
            const evt = JSON.parse(ln);
            if (evt.event === "init") convoId = String(evt.conversation_id || convoId);
            else if (evt.event === "step_update" && evt.step_update?.step_type === "tool") {
              lastToolInfo = evt.step_update.tool_info;
            } else if (evt.event === "result") {
              resultObj = evt.result || {};
              convoId = String(resultObj.conversation_id || convoId);
            }
          } catch {
            continue;
          }
        }
        if (!resultObj || resultObj.status !== "SUCCESS") {
          return Response.json({ error: { message: JSON.stringify(resultObj), type: "AgyCliStatusError" } }, { status: 502 });
        }
        const usage = resultObj.usage || {};
        const pTok = Number(usage.input_tokens || 0);
        const cTok = Number(usage.output_tokens || 0);
        const cachedTok = Number(usage.cache_read_tokens || 0);
        const tTok = Number(usage.total_tokens || pTok + cTok);
        const deniedActions = Array.isArray(resultObj.denied_actions) ? resultObj.denied_actions : [];
        let replyText = String(resultObj.response || "");
        const nextTurn = resumedEntry ? resumedEntry.turnCount + 1 : 1;

        const delegatedTc = await mapDeniedToolToOpencode(
          lastToolInfo,
          deniedActions,
          clientTools,
          workspaceDir,
          convoId,
          requestedModel
        );
        if (delegatedTc) {
          storeSession(workspaceDir, [...canonicalTurns, ["assistant_tc", delegatedTc.function.name]], convoId, nextTurn);
          auditRing.push({
            timestamp: new Date().toISOString(),
            runtime: "in-process-opencode-plugin",
            requested_model: requestedModel,
            conversation_id: convoId,
            resumed: Boolean(resumedConvoId),
            workspace_dir: workspaceDir,
            workspace_source: workspaceSource,
            delegated_tool_call: delegatedTc.function.name,
            status: "DELEGATED_TOOL_CALL",
            duration_seconds: Number(((Date.now() - startedMs) / 1000).toFixed(3)),
            usage,
          });
          if (auditRing.length > 50) auditRing.shift();
          return Response.json({
            id: completionId,
            object: "chat.completion",
            created,
            model: requestedModel,
            choices: [{ index: 0, message: { role: "assistant", content: replyText || null, tool_calls: [delegatedTc] }, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: pTok, completion_tokens: cTok, total_tokens: tTok, prompt_tokens_details: { cached_tokens: cachedTok } },
          });
        }

        if (deniedActions.length > 0 && !replyText) {
          replyText = `[Antigravity Permission Required] Action blocked in headless mode: ${JSON.stringify(deniedActions)}`;
        }
        if (replyText.trim()) {
          storeSession(workspaceDir, [...canonicalTurns, ["assistant", replyText.trim()]], convoId, nextTurn);
        }
        auditRing.push({
          timestamp: new Date().toISOString(),
          runtime: "in-process-opencode-plugin",
          requested_model: requestedModel,
          conversation_id: convoId,
          resumed: Boolean(resumedConvoId),
          workspace_dir: workspaceDir,
          workspace_source: workspaceSource,
          status: "SUCCESS",
          duration_seconds: Number(((Date.now() - startedMs) / 1000).toFixed(3)),
          usage,
        });
        if (auditRing.length > 50) auditRing.shift();
        return Response.json({
          id: completionId,
          object: "chat.completion",
          created,
          model: requestedModel,
          choices: [{ index: 0, message: { role: "assistant", content: replyText }, finish_reason: "stop" }],
          usage: { prompt_tokens: pTok, completion_tokens: cTok, total_tokens: tTok, prompt_tokens_details: { cached_tokens: cachedTok } },
        });
      }

      const encoder = new TextEncoder();
      const sseStream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const sendChunk = (obj: any) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
          sendChunk({
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model: requestedModel,
            choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
          });

          const proc = Bun.spawn(cmd, { cwd: workspaceDir, stdout: "pipe", stderr: "pipe", env: buildAgyEnv() });
          const reader = proc.stdout.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          let convoId = resumedConvoId || "";
          let effModel = requestedModel;
          let finalStatus = "UNKNOWN";
          let usageRaw: any = {};
          let lastToolInfo: any = null;
          let deniedActions: any[] = [];
          let emittedText = false;
          const collected: string[] = [];

          const processLine = (rawLn: string) => {
            const ln = rawLn.trim();
            if (!ln.startsWith("{")) return;
            try {
              const evt = JSON.parse(ln);
              if (evt.event === "init") {
                convoId = String(evt.conversation_id || convoId);
                effModel = String(evt.init?.model || effModel);
              } else if (evt.event === "step_update") {
                const su = evt.step_update || {};
                if (su.step_type === "tool" && su.tool_info) {
                  lastToolInfo = su.tool_info;
                } else if (su.step_type === "agent_response" && typeof su.text_delta === "string" && su.text_delta !== "") {
                  emittedText = true;
                  collected.push(su.text_delta);
                  sendChunk({
                    id: completionId,
                    object: "chat.completion.chunk",
                    created,
                    model: effModel,
                    choices: [{ index: 0, delta: { content: su.text_delta }, finish_reason: null }],
                  });
                }
                if (su.usage) usageRaw = su.usage;
              } else if (evt.event === "result") {
                const res = evt.result || {};
                convoId = String(res.conversation_id || convoId);
                finalStatus = String(res.status || "UNKNOWN");
                deniedActions = Array.isArray(res.denied_actions) ? res.denied_actions : [];
                if (res.usage) usageRaw = res.usage;
                if (finalStatus === "SUCCESS" && !emittedText && res.response) {
                  const txt = String(res.response);
                  emittedText = true;
                  collected.push(txt);
                  sendChunk({
                    id: completionId,
                    object: "chat.completion.chunk",
                    created,
                    model: effModel,
                    choices: [{ index: 0, delta: { content: txt }, finish_reason: null }],
                  });
                }
              }
            } catch {
              // ignore non-JSON line
            }
          };

          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = buf.indexOf("\n")) !== -1) {
              const line = buf.slice(0, idx);
              buf = buf.slice(idx + 1);
              processLine(line);
            }
          }
          if (buf.trim()) processLine(buf);

          const [stderrTxt, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
          if (exitCode !== 0 || finalStatus !== "SUCCESS") {
            sendChunk({ error: { message: stderrTxt.trim() || `agy status=${finalStatus}`, type: "AgyCliStreamError" } });
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
            return;
          }

          const pTok = Number(usageRaw.input_tokens || 0);
          const cTok = Number(usageRaw.output_tokens || 0);
          const cachedTok = Number(usageRaw.cache_read_tokens || 0);
          const tTok = Number(usageRaw.total_tokens || pTok + cTok);
          const nextTurn = resumedEntry ? resumedEntry.turnCount + 1 : 1;

          const delegatedTc = await mapDeniedToolToOpencode(
            lastToolInfo,
            deniedActions,
            clientTools,
            workspaceDir,
            convoId,
            requestedModel
          );

          if (delegatedTc) {
            storeSession(workspaceDir, [...canonicalTurns, ["assistant_tc", delegatedTc.function.name]], convoId, nextTurn);
            const partialTxt = collected.join("").trim();
            if (partialTxt) {
              storeSession(
                workspaceDir,
                [...canonicalTurns, ["assistant", partialTxt], ["assistant_tc", delegatedTc.function.name]],
                convoId,
                nextTurn
              );
            }
            auditRing.push({
              timestamp: new Date().toISOString(),
              runtime: "in-process-opencode-plugin",
              requested_model: requestedModel,
              conversation_id: convoId,
              resumed: Boolean(resumedConvoId),
              workspace_dir: workspaceDir,
              workspace_source: workspaceSource,
              delegated_tool_call: delegatedTc.function.name,
              status: "DELEGATED_TOOL_CALL",
              duration_seconds: Number(((Date.now() - startedMs) / 1000).toFixed(3)),
              usage: usageRaw,
            });
            if (auditRing.length > 50) auditRing.shift();
            sendChunk({
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model: effModel,
              choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...delegatedTc }] }, finish_reason: null }],
            });
            sendChunk({
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model: effModel,
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
              usage: { prompt_tokens: pTok, completion_tokens: cTok, total_tokens: tTok, prompt_tokens_details: { cached_tokens: cachedTok } },
            });
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
            return;
          }

          if (deniedActions.length > 0 && !emittedText) {
            const fb = `[Antigravity Permission Required] Action blocked in headless mode: ${JSON.stringify(deniedActions)}`;
            collected.push(fb);
            sendChunk({
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model: effModel,
              choices: [{ index: 0, delta: { content: fb }, finish_reason: null }],
            });
          }

          const fullTxt = collected.join("").trim();
          if (fullTxt) {
            storeSession(workspaceDir, [...canonicalTurns, ["assistant", fullTxt]], convoId, nextTurn);
          }
          auditRing.push({
            timestamp: new Date().toISOString(),
            runtime: "in-process-opencode-plugin",
            requested_model: requestedModel,
            conversation_id: convoId,
            resumed: Boolean(resumedConvoId),
            workspace_dir: workspaceDir,
            workspace_source: workspaceSource,
            status: finalStatus,
            duration_seconds: Number(((Date.now() - startedMs) / 1000).toFixed(3)),
            usage: usageRaw,
          });
          if (auditRing.length > 50) auditRing.shift();
          sendChunk({
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model: effModel,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: pTok, completion_tokens: cTok, total_tokens: tTok, prompt_tokens_details: { cached_tokens: cachedTok } },
          });
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });

      return new Response(sseStream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "x-agy-runtime": "in-process-opencode-plugin",
          "x-agy-conversation-resumed": String(Boolean(resumedConvoId)),
        },
      });
    }

    return Response.json({ error: { message: `Not found: ${path}` } }, { status: 404 });
  }

  const desiredPort = (resolvedRoutingMode as string) === "through-bifrost" ? localBridgePort : 0;
  let embeddedServer: ReturnType<typeof Bun.serve> | null = null;
  try {
    embeddedServer = Bun.serve({
      hostname: "127.0.0.1",
      port: desiredPort,
      idleTimeout: 255,
      fetch: handleBridgeRequest,
    });
  } catch {
    embeddedServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 255,
      fetch: handleBridgeRequest,
    });
  }
  embeddedServer.unref();

  async function discoverInventories() {
    const standardModels: Record<string, string> = {};
    if (vkDefault) {
      try {
        const r = await fetch(`${bifrostUrl}/v1/models`, {
          headers: { Authorization: `Bearer ${vkDefault}` },
          signal: AbortSignal.timeout(5_000),
        });
        if (r.ok) {
          const data = (await r.json()) as { data?: Array<{ id?: string }> };
          for (const m of data.data || []) {
            const id = String(m?.id || "");
            if (id && !id.startsWith("agy-cli/")) {
              standardModels[id] = `${id} (Bifrost)`;
            }
          }
        }
      } catch {
        // Non-fatal during offline startup
      }
    }

    const agyModels: Record<string, string> = {
      "agy-cli/policy-routed": "Antigravity CLI — Bifrost Policy-Configured Model (Gemini Enterprise)",
    };
    const discoveredAliases: string[] = [];
    try {
      const liveAgyCatalog = await discoverAgyModels(false);
      let allowedSet: Set<string> | null = null;
      if (vkAgy) {
        const check = await validateCentralVirtualKey(vkAgy);
        if (check.status === 200 && check.allowed.size > 0) {
          if (!check.allowed.has("*")) {
            allowedSet = check.allowed;
          }
          for (const slug of check.allowed) {
            if (!liveAgyCatalog[slug] && slug !== "policy-routed" && slug !== "*") {
              agyModels[`agy-cli/${slug}`] = `Antigravity CLI — Bifrost Alias '${slug}' (Gemini Enterprise)`;
              if (slug.startsWith("agy-") && !discoveredAliases.includes(slug)) {
                discoveredAliases.push(slug);
              }
            }
          }
        }
      }
      for (const [slug, displayName] of Object.entries(liveAgyCatalog)) {
        if (!allowedSet || allowedSet.has(slug)) {
          agyModels[`agy-cli/${slug}`] = `Antigravity — ${displayName} (Gemini Enterprise)`;
        }
      }
      if (opts.modelAliases && typeof opts.modelAliases === "object") {
        for (const [rawAlias, rawTarget] of Object.entries(opts.modelAliases)) {
          const alias = String(rawAlias || "").trim();
          const target = String(rawTarget || "").trim();
          if (!alias || !target) continue;
          if (liveAgyCatalog[target] && (!allowedSet || allowedSet.has(target) || allowedSet.has(alias))) {
            agyModels[`agy-cli/${alias}`] = `Antigravity — ${liveAgyCatalog[target]} [${alias}] (Gemini Enterprise)`;
            if (!discoveredAliases.includes(alias)) {
              discoveredAliases.push(alias);
            }
          } else if (!allowedSet || allowedSet.has(target) || allowedSet.has(alias)) {
            agyModels[`agy-cli/${alias}`] = `Antigravity CLI — Alias '${alias}' -> '${target}' (Gemini Enterprise)`;
            if (!discoveredAliases.includes(alias)) {
              discoveredAliases.push(alias);
            }
          }
        }
      }
    } catch {
      // Keep policy-routed registered even before ADC login so /agy-doctor is always available
      if (opts.modelAliases && typeof opts.modelAliases === "object") {
        for (const [rawAlias, rawTarget] of Object.entries(opts.modelAliases)) {
          const alias = String(rawAlias || "").trim();
          const target = String(rawTarget || "").trim();
          if (alias && target) {
            agyModels[`agy-cli/${alias}`] = `Antigravity CLI — Alias '${alias}' -> '${target}' (Gemini Enterprise)`;
            if (!discoveredAliases.includes(alias)) {
              discoveredAliases.push(alias);
            }
          }
        }
      }
    }

    const agyBaseUrl =
      resolvedRoutingMode === "through-bifrost"
        ? `${bifrostUrl}/v1`
        : `http://127.0.0.1:${embeddedServer?.port}/v1`;

    return { standardModels, agyModels, discoveredAliases, agyBaseUrl };
  }

  async function runDoctor(activeWorkspace: string) {
    const currentAdc = readAdcInfo(userHome);
    let agyVersion = "unavailable";
    let modelCount = 0;
    try {
      const vProc = Bun.spawn([agyBin, "--version"], { stdout: "pipe", stderr: "pipe" });
      agyVersion = (await new Response(vProc.stdout).text()).trim();
      const cat = await discoverAgyModels(true);
      modelCount = Object.keys(cat).length;
    } catch (e: any) {
      agyVersion = `error: ${e?.message || e}`;
    }
    const vkStatus = vkAgy
      ? await validateCentralVirtualKey(vkAgy)
      : { status: 0, allowed: new Set<string>(), error: "vkAgy unset" };
    return {
      plugin_runtime: `${PLUGIN_ID}@${PLUGIN_VERSION} (in-process, zero external daemons)`,
      routing_mode: resolvedRoutingMode,
      embedded_bridge_port: embeddedServer?.port || null,
      active_workspace: activeWorkspace,
      agy_bin: agyBin,
      agy_version: agyVersion,
      live_agy_models_discovered: modelCount,
      adc_type: currentAdc.type,
      adc_is_human_seat: currentAdc.type === "authorized_user",
      gcp_project_id: gcpProjectId,
      gcp_location: gcpLocation,
      baicode_user_tier: baicodeUserTier,
      permission_mode: permissionMode,
      bifrost_url: bifrostUrl,
      bifrost_vk_agy_http_status: vkStatus.status,
      bifrost_allowed_agy_models: vkStatus.allowed.size,
      active_cached_conversations: sessionMap.size,
    };
  }

  function stopServer() {
    if (embeddedServer) {
      embeddedServer.stop(true);
      embeddedServer = null;
    }
  }

  return {
    opts,
    userHome,
    getState: () => ({
      bifrostUrl,
      gcpProjectId,
      gcpLocation,
      baicodeUserTier,
      permissionMode,
      vkAgy,
      vkDefault,
      resolvedRoutingMode,
      embeddedPort: embeddedServer?.port || null,
    }),
    setLatestWorkspace: (dir: string) => {
      latestActiveOpencodeDir = resolve(dir);
    },
    applyCredentialOverrides,
    discoverInventories,
    runDoctor,
    stopServer,
  };
}

/**
 * OpenCode V1 legacy server hook (`1.18.29` / `1.19.x` compatibility)
 */
export async function BifrostAgyPlugin(
  pluginInput: { directory: string },
  rawOptions: BifrostAgyPluginOptions = {}
) {
  const runtime = createBridgeRuntime(pluginInput.directory, rawOptions as Record<string, unknown>);
  const adcInfo = readAdcInfo(runtime.userHome);

  return {
    dispose: async () => {
      runtime.stopServer();
    },

    auth: {
      provider: "bifrost-agy",
      methods: [
        {
          type: "api" as const,
          label: "Configure Bifrost Gateway + Gemini Enterprise Seat",
          prompts: [
            {
              type: "text" as const,
              key: "bifrostUrl",
              message: "Bifrost Gateway URL",
              placeholder: "https://bifrost.example.internal (or http://127.0.0.1:8080)",
              validate: (v: string) => (/^https?:\/\/.+/.test(v.trim()) ? undefined : "Enter a valid http:// or https:// URL"),
            },
            {
              type: "text" as const,
              key: "vkAgy",
              message: "Bifrost Virtual Key for /agy (Gemini Enterprise)",
              placeholder: "sk-bf-agy-...",
              validate: (v: string) => (v.trim().length > 3 ? undefined : "Required"),
            },
            {
              type: "text" as const,
              key: "vkDefault",
              message: "Bifrost Standard Virtual Key (for default coding turns)",
              placeholder: "sk-bf-std-...",
              validate: (v: string) => (v.trim().length > 3 ? undefined : "Required"),
            },
            {
              type: "text" as const,
              key: "gcpProjectId",
              message: "Gemini Enterprise GCP Quota Project ID",
              placeholder: adcInfo.quotaProjectId || "your-gcp-project-id",
              validate: (v: string) => (v.trim().length > 2 ? undefined : "Required"),
            },
            {
              type: "select" as const,
              key: "gcpLocation",
              message: "Gemini Enterprise Location",
              options: [
                { label: "global (Default)", value: "global" },
                { label: "us (Multi-region)", value: "us" },
                { label: "eu (Multi-region)", value: "eu" },
              ],
            },
            {
              type: "select" as const,
              key: "baicodeUserTier",
              message: "Gemini Enterprise License Tier (for Developer Tools Metrics)",
              options: [
                { label: "Gemini Enterprise Plus (gcp-ge-plus-tier)", value: "gcp-ge-plus-tier" },
                { label: "Gemini Enterprise Standard (gcp-ge-standard-tier)", value: "gcp-ge-standard-tier" },
              ],
            },
            {
              type: "select" as const,
              key: "permissionMode",
              message: "Headless Antigravity Workspace Permission Posture",
              options: [
                {
                  label: "accept-edits (Recommended — edits allowed in repo; bash & external reads prompt in OpenCode)",
                  value: "accept-edits",
                },
                { label: "strict (Prompt in OpenCode for file writes, bash, and external reads)", value: "strict" },
              ],
            },
          ],
          authorize: async (inputs: Record<string, string> = {}) => {
            const url = String(inputs.bifrostUrl || runtime.getState().bifrostUrl).replace(/\/+$/, "");
            const key = String(inputs.vkAgy || "").trim();
            const res = await fetch(`${url}/v1/models`, {
              headers: { Authorization: `Bearer ${key}` },
            }).catch(() => null);
            if (!res || !res.ok) {
              return { type: "failed" as const };
            }
            return {
              type: "success" as const,
              key,
              provider: "bifrost-agy",
              metadata: {
                bifrostUrl: url,
                vkDefault: String(inputs.vkDefault || "").trim(),
                gcpProjectId: String(inputs.gcpProjectId || "").trim(),
                gcpLocation: String(inputs.gcpLocation || "global").trim(),
                baicodeUserTier: String(inputs.baicodeUserTier || "gcp-ge-plus-tier").trim(),
                permissionMode: String(inputs.permissionMode || "accept-edits").trim(),
              },
            };
          },
        },
      ],
    },

    config: async (cfg: any) => {
      cfg.provider = cfg.provider || {};
      cfg.agent = cfg.agent || {};
      cfg.command = cfg.command || {};

      const inv = await runtime.discoverInventories();
      const st = runtime.getState();

      if (st.vkDefault || Object.keys(inv.standardModels).length > 0) {
        const stdModelsObj: Record<string, { name: string }> = {};
        for (const [id, name] of Object.entries(inv.standardModels)) {
          stdModelsObj[id] = { name };
        }
        cfg.provider["bifrost"] = {
          npm: "@ai-sdk/openai-compatible",
          name: "Bifrost AI Gateway",
          options: {
            baseURL: `${st.bifrostUrl}/v1`,
            apiKey: st.vkDefault || "{env:BIFROST_VK_DEFAULT}",
          },
          models: stdModelsObj,
        };
        const firstStdId = Object.keys(inv.standardModels)[0];
        const firstStdModel = runtime.opts.defaultCodingModel || (firstStdId ? `bifrost/${firstStdId}` : undefined);
        if (firstStdModel && !cfg.model) {
          cfg.model = firstStdModel;
          cfg.small_model = cfg.small_model || firstStdModel;
        }
      }

      const agyModelsObj: Record<string, { name: string }> = {};
      for (const [id, name] of Object.entries(inv.agyModels)) {
        agyModelsObj[id] = { name };
      }
      cfg.provider["bifrost-agy"] = {
        npm: "@ai-sdk/openai-compatible",
        name: "Antigravity CLI (Bifrost Policy + Gemini Enterprise Plugin)",
        options: {
          baseURL: inv.agyBaseUrl,
          apiKey: st.vkAgy || "{env:BIFROST_VK_AGY}",
        },
        models: agyModelsObj,
      };

      cfg.enabled_providers = Array.from(new Set([...(cfg.enabled_providers || []), "bifrost", "bifrost-agy"]));

      for (const stdAgent of ["build", "plan", "general", "explore"]) {
        cfg.agent[stdAgent] = {
          ...(cfg.model ? { model: cfg.model } : {}),
          permission: { antigravity: "deny" },
          ...(cfg.agent[stdAgent] || {}),
        };
      }

      cfg.agent["agy"] = {
        description: "Policy-governed Antigravity CLI agent via Gemini Enterprise (Zero-Daemon Plugin)",
        mode: "all",
        model: "bifrost-agy/agy-cli/policy-routed",
        permission: { antigravity: "allow" },
        ...(cfg.agent["agy"] || {}),
      };

      cfg.command["agy"] = {
        description: "Execute via Antigravity CLI using Bifrost's active model policy (Gemini Enterprise)",
        agent: "agy",
        model: "bifrost-agy/agy-cli/policy-routed",
        template: "$ARGUMENTS",
        ...(cfg.command["agy"] || {}),
      };

      for (const alias of inv.discoveredAliases) {
        cfg.command[alias] = {
          description: `Execute via Antigravity CLI using Bifrost alias '${alias}' (Gemini Enterprise)`,
          agent: "agy",
          model: `bifrost-agy/agy-cli/${alias}`,
          template: "$ARGUMENTS",
          ...(cfg.command[alias] || {}),
        };
      }

      cfg.command["agy-doctor"] = {
        description: "Verify Antigravity CLI, Gemini Enterprise ADC seat, BAICODE_USER_TIER, and Bifrost Gateway connectivity",
        template: "Call the `agy_doctor` tool and present a concise readiness table.",
      };
    },

    "chat.headers": async (input: { sessionID: string }, output: { headers: Record<string, string> }) => {
      runtime.setLatestWorkspace(pluginInput.directory);
      output.headers["x-opencode-session-id"] = input.sessionID;
      output.headers["x-opencode-workspace-dir"] = resolve(pluginInput.directory);
    },

    tool: {
      agy_doctor: {
        description:
          "Runs a live preflight check across Antigravity CLI (`agy`), Google Cloud human ADC (`authorized_user`), Gemini Enterprise `BAICODE_USER_TIER`, and Bifrost Gateway Virtual Key RBAC.",
        args: {},
        async execute(_args: Record<string, never>, context: { directory: string }) {
          const report = await runtime.runDoctor(context.directory);
          return JSON.stringify(report, null, 2);
        },
      },
    },
  };
}

function formatDoctorMarkdown(report: Record<string, unknown>): string {
  const rows = [
    ["Plugin Runtime", `\`${report.plugin_runtime}\``],
    ["Routing Mode", `\`${report.routing_mode}\` (port \`${report.embedded_bridge_port}\`)`],
    ["Active Workspace", `\`${report.active_workspace}\``],
    ["Antigravity CLI (`agy`)", `\`${report.agy_bin}\` — \`${report.agy_version}\``],
    ["Live `agy models` Discovered", `\`${report.live_agy_models_discovered}\``],
    ["Human ADC Seat (`authorized_user`)", `\`${report.adc_is_human_seat}\` (\`${report.adc_type}\`)`],
    ["Gemini Enterprise Project / Location", `\`${report.gcp_project_id || "(unset)"}\` / \`${report.gcp_location}\``],
    ["`BAICODE_USER_TIER` (Metrics)", `\`${report.baicode_user_tier}\``],
    ["Permission Mode", `\`${report.permission_mode}\``],
    ["Bifrost Gateway URL", `\`${report.bifrost_url}\``],
    ["Bifrost `/agy` VK Status", `HTTP \`${report.bifrost_vk_agy_http_status}\` (\`${report.bifrost_allowed_agy_models}\` allowed models)`],
    ["Cached `agy` Conversations (15m TTL)", `\`${report.active_cached_conversations}\``],
  ];
  const lines = [
    "### `opencode-bifrost-agy` Readiness Report",
    "",
    "| Check | Value |",
    "| :--- | :--- |",
    ...rows.map(([k, v]) => `| **${k}** | ${v} |`),
  ];
  return lines.join("\n");
}

/**
 * Dual OpenCode V2 (`Plugin.define({ id, setup(ctx) })`) + OpenCode V1 (`server()`) default export.
 */
export default {
  ...defineV2Plugin({
    id: PLUGIN_ID,
    async setup(ctx) {
      const runtime = createBridgeRuntime(ctx.location.directory, ctx.options);
      const adcInfo = readAdcInfo(runtime.userHome);
      const initialState = runtime.getState();

      // 1. Register Integrations for `/connect` & `opencode auth login bifrost-agy`
      await ctx.integration.transform((editor) => {
        editor.update("bifrost-agy", (integration) => {
          integration.name = "Antigravity CLI (Bifrost Policy + Gemini Enterprise)";
        });
        editor.method.update({
          integrationID: "bifrost-agy",
          method: {
            type: "key",
            label: "Configure Bifrost Gateway + Gemini Enterprise Seat (/agy Virtual Key)",
            form: [
              {
                type: "string",
                key: "bifrostUrl",
                title: "Bifrost Gateway URL",
                placeholder: "https://bifrost.example.internal (or http://127.0.0.1:8080)",
                default: initialState.bifrostUrl,
                pattern: "^https?://\\S+$",
                required: true,
              },
              {
                type: "string",
                key: "vkDefault",
                title: "Bifrost Standard Virtual Key (optional, for default non-agy coding models)",
                placeholder: "sk-bf-std-...",
              },
              {
                type: "string",
                key: "gcpProjectId",
                title: "Gemini Enterprise GCP Quota Project ID",
                placeholder: adcInfo.quotaProjectId || "your-gcp-project-id",
                ...(initialState.gcpProjectId ? { default: initialState.gcpProjectId } : {}),
              },
              {
                type: "string",
                key: "gcpLocation",
                title: "Gemini Enterprise Location",
                default: initialState.gcpLocation,
                options: [
                  { label: "global (Default)", value: "global" },
                  { label: "us (Multi-region)", value: "us" },
                  { label: "eu (Multi-region)", value: "eu" },
                ],
              },
              {
                type: "string",
                key: "baicodeUserTier",
                title: "Gemini Enterprise License Tier (Developer Tools Metrics)",
                default: initialState.baicodeUserTier,
                options: [
                  { label: "Gemini Enterprise Plus (gcp-ge-plus-tier)", value: "gcp-ge-plus-tier" },
                  { label: "Gemini Enterprise Standard (gcp-ge-standard-tier)", value: "gcp-ge-standard-tier" },
                ],
              },
              {
                type: "string",
                key: "permissionMode",
                title: "Headless Antigravity Workspace Permission Posture",
                default: initialState.permissionMode,
                options: [
                  {
                    label: "accept-edits (Recommended — edits allowed in repo; bash & external reads prompt in OpenCode)",
                    value: "accept-edits",
                  },
                  { label: "strict (Prompt in OpenCode for file writes, bash, and external reads)", value: "strict" },
                ],
              },
            ],
          },
        });
        editor.method.update({
          integrationID: "bifrost-agy",
          method: {
            type: "env",
            names: ["BIFROST_VK_AGY"],
          },
        });

        editor.update("bifrost", (integration) => {
          integration.name = "Bifrost AI Gateway (Standard Coding Models)";
        });
        editor.method.update({
          integrationID: "bifrost",
          method: {
            type: "key",
            label: "Bifrost Standard Virtual Key",
          },
        });
        editor.method.update({
          integrationID: "bifrost",
          method: {
            type: "env",
            names: ["BIFROST_VK_DEFAULT"],
          },
        });
      });

      const bifrostProviderID = makeProviderID("bifrost");
      const bifrostAgyProviderID = makeProviderID("bifrost-agy");

      const currentSource: {
        standardModels: Model.Info[];
        agyModels: Model.Info[];
        discoveredAliases: string[];
        agyBaseUrl: string;
      } = {
        standardModels: [],
        agyModels: [],
        discoveredAliases: [],
        agyBaseUrl: `http://127.0.0.1:${initialState.embeddedPort}/v1`,
      };

      const syncCredentialsAndInventories = async () => {
        const agyConn = await ctx.integration.connection.active("bifrost-agy").catch(() => undefined);
        const agyCred = agyConn ? await ctx.integration.connection.resolve(agyConn).catch(() => undefined) : undefined;

        const stdConn = await ctx.integration.connection.active("bifrost").catch(() => undefined);
        const stdCred = stdConn ? await ctx.integration.connection.resolve(stdConn).catch(() => undefined) : undefined;

        runtime.applyCredentialOverrides({
          vkAgy: agyCred?.type === "key" ? agyCred.key : undefined,
          vkDefault: stdCred?.type === "key" ? stdCred.key : undefined,
          metadata: agyCred?.metadata,
        });

        const inv = await runtime.discoverInventories();
        currentSource.agyBaseUrl = inv.agyBaseUrl;
        currentSource.discoveredAliases = inv.discoveredAliases;

        currentSource.standardModels = Object.entries(inv.standardModels).map(([id, name]) => ({
          ...makeDefaultModelInfo(bifrostProviderID, makeModelID(id)),
          name,
        }));

        currentSource.agyModels = Object.entries(inv.agyModels).map(([id, name]) => ({
          ...makeDefaultModelInfo(bifrostAgyProviderID, makeModelID(id)),
          name,
          capabilities: {
            tools: true,
            input: ["text", "image"],
            output: ["text"],
          },
          limit: {
            context: 1_000_000,
            output: 65_536,
          },
        }));
      };

      await syncCredentialsAndInventories();

      // 2. Register Providers & Models (`bifrost` + `bifrost-agy`)
      await ctx.provider.transform((editor) => {
        const st = runtime.getState();

        if (st.vkDefault || currentSource.standardModels.length > 0) {
          editor.add({
            info: {
              ...makeEmptyProviderInfo(bifrostProviderID),
              integrationID: makeIntegrationID("bifrost"),
              name: "Bifrost AI Gateway",
              activation: "enabled",
              package: "@opencode/ai/providers/openai-compatible",
              settings: {
                baseURL: `${st.bifrostUrl}/v1`,
                ...(st.vkDefault ? { apiKey: st.vkDefault } : {}),
                encoding: "none",
              },
            },
            models: currentSource.standardModels,
          });
        }

        editor.add({
          info: {
            ...makeEmptyProviderInfo(bifrostAgyProviderID),
            integrationID: makeIntegrationID("bifrost-agy"),
            name: "Antigravity CLI (Bifrost Policy + Gemini Enterprise Plugin)",
            activation: "enabled",
            package: "@opencode/ai/providers/openai-compatible",
            settings: {
              baseURL: currentSource.agyBaseUrl,
              ...(st.vkAgy ? { apiKey: st.vkAgy } : {}),
              encoding: "none",
              headerTimeout: 600_000,
              chunkTimeout: 900_000,
            },
            headers: {
              "x-opencode-workspace-dir": ctx.location.directory,
            },
          },
          models: currentSource.agyModels,
        });
      });

      await ctx.model.transform((editor) => {
        if (!editor.default.get()) {
          if (runtime.opts.defaultCodingModel && runtime.opts.defaultCodingModel.includes("/")) {
            const idx = runtime.opts.defaultCodingModel.indexOf("/");
            editor.default.set(
              runtime.opts.defaultCodingModel.slice(0, idx),
              runtime.opts.defaultCodingModel.slice(idx + 1)
            );
          } else if (currentSource.standardModels.length > 0) {
            editor.default.set("bifrost", currentSource.standardModels[0].id);
          }
        }
      });

      // 3. Register `agy` Agent
      await ctx.agent.transform((editor) => {
        editor.update("agy", (agent) => {
          agent.name = makeAgentName("agy");
          agent.description = "Policy-governed Antigravity CLI agent via Gemini Enterprise (Zero-Daemon Plugin)";
          agent.mode = "all";
          agent.hidden = false;
          agent.model = {
            providerID: bifrostAgyProviderID,
            id: makeModelID("agy-cli/policy-routed"),
          };
        });
      });

      // 4. Register Slash Commands (`/agy`, `/agy-*` aliases, and `/agy-doctor`)
      await ctx.command.transform((editor) => {
        const registerAgyCommand = (cmdName: string, modelId: string, description: string) => {
          editor.add({
            name: cmdName,
            description,
            execute: async ({ sessionID, prompt, delivery }) => {
              await ctx.session.switchAgent({ sessionID, agent: makeAgentID("agy") });
              await ctx.session.switchModel({
                sessionID,
                model: {
                  providerID: bifrostAgyProviderID,
                  id: makeModelID(modelId),
                },
              });
              await ctx.session.prompt({
                ...prompt,
                sessionID,
                text: prompt.text || "Summarize the current workspace and confirm readiness.",
                delivery,
              });
            },
          });
        };

        registerAgyCommand(
          "agy",
          "agy-cli/policy-routed",
          "Execute via Antigravity CLI using Bifrost's active model policy (Gemini Enterprise)"
        );

        for (const alias of currentSource.discoveredAliases) {
          registerAgyCommand(
            alias,
            `agy-cli/${alias}`,
            `Execute via Antigravity CLI using Bifrost alias '${alias}' (Gemini Enterprise)`
          );
        }

        editor.add({
          name: "agy-doctor",
          description: "Verify Antigravity CLI, Gemini Enterprise ADC seat, BAICODE_USER_TIER, and Bifrost Gateway connectivity",
          execute: async ({ sessionID }) => {
            const report = await runtime.runDoctor(ctx.location.directory);
            await ctx.session.synthetic({
              sessionID,
              text: formatDoctorMarkdown(report),
              description: "Antigravity + Bifrost + Gemini Enterprise Diagnostics",
            });
          },
        });
      });

      // 5. Register `agy_doctor` Tool
      await ctx.tool.transform((editor) => {
        editor.add({
          name: "agy_doctor",
          description:
            "Runs a live preflight check across Antigravity CLI (`agy`), Google Cloud human ADC (`authorized_user`), Gemini Enterprise `BAICODE_USER_TIER`, and Bifrost Gateway Virtual Key RBAC.",
          input: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          async execute() {
            const report = await runtime.runDoctor(ctx.location.directory);
            return { content: JSON.stringify(report, null, 2) };
          },
        });
      });

      // 6. Attach Session & Workspace Headers on Outbound HTTP Calls to `bifrost-agy`
      await ctx.session.hook(
        "http.request",
        (event) => {
          runtime.setLatestWorkspace(ctx.location.directory);
          event.request.headers.set("x-opencode-session-id", event.sessionID);
          event.request.headers.set("x-opencode-workspace-dir", ctx.location.directory);
        },
        { providerID: "bifrost-agy" }
      );

      // 7. Auto-reload Inventories When User Connects / Switches Credentials via `/connect` or `opencode auth`
      const eventAbort = new AbortController();
      void (async () => {
        try {
          for await (const evt of ctx.event.subscribe({
            types: ["credential.updated", "credential.switched"],
            signal: eventAbort.signal,
          })) {
            const intId = String((evt as any)?.data?.integrationID || "");
            if (intId === "bifrost-agy" || intId === "bifrost") {
              await syncCredentialsAndInventories();
              await Promise.all([
                ctx.provider.reload(),
                ctx.model.reload(),
                ctx.agent.reload(),
                ctx.command.reload(),
              ]);
            }
          }
        } catch {
          // Aborted on plugin unload
        }
      })();

      return () => {
        eventAbort.abort();
        runtime.stopServer();
      };
    },
  }),

  server: BifrostAgyPlugin,
};
