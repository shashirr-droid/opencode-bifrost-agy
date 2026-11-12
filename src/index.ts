import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { tool, type Plugin } from "@opencode-ai/plugin";

export interface BifrostAgyPluginOptions {
  /** Base URL of Central or Local Bifrost Gateway (e.g. "https://bifrost.internal.example.com" or "http://127.0.0.1:8080") */
  bifrostUrl?: string;
  /** Routing topology: "auto" | "through-bifrost" (Bifrost -> plugin) | "central-bifrost" (OpenCode -> plugin -> Central Bifrost policy check + local agy) */
  routingMode?: "auto" | "through-bifrost" | "central-bifrost";
  /** Standard Bifrost Virtual Key (falls back to auth.json or env BIFROST_VK_DEFAULT) */
  vkDefault?: string;
  /** Bifrost Virtual Key authorized for /agy (falls back to auth.json or env BIFROST_VK_AGY) */
  vkAgy?: string;
  /** Optional Basic Auth user/password for reading Central Bifrost /api/routing/rules in central-bifrost mode */
  bifrostPolicyUser?: string;
  bifrostPolicyPassword?: string;
  /** Fallback concrete agy model slug when Central Bifrost rules API is not exposed to workstations */
  defaultAgyPolicyModel?: string;
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
  /** Comma-separated allowed workspace root prefixes */
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

interface StoredAuthFile {
  [providerId: string]: {
    type?: string;
    key?: string;
    metadata?: Record<string, string>;
  };
}

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
  const adcPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || join(userHome, ".config", "gcloud", "application_default_credentials.json");
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

function readOpencodeAuth(userHome: string): StoredAuthFile {
  const authPath = join(userHome, ".local", "share", "opencode", "auth.json");
  if (!existsSync(authPath)) return {};
  try {
    return JSON.parse(readFileSync(authPath, "utf-8")) as StoredAuthFile;
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

export const BifrostAgyPlugin: Plugin = async (pluginInput, rawOptions = {}) => {
  const opts = (rawOptions || {}) as BifrostAgyPluginOptions;
  const userHome = homedir();
  const savedAuth = readOpencodeAuth(userHome);
  const savedMeta = savedAuth["bifrost-agy"]?.metadata || {};
  const adcInfo = readAdcInfo(userHome);

  const bifrostUrl = String(
    opts.bifrostUrl || savedMeta.bifrostUrl || process.env.BIFROST_URL || "http://127.0.0.1:8080"
  ).replace(/\/+$/, "");

  const gcpProjectId = String(
    opts.gcpProjectId ||
      savedMeta.gcpProjectId ||
      process.env.GOOGLE_CLOUD_PROJECT ||
      process.env.GOOGLE_CLOUD_QUOTA_PROJECT ||
      adcInfo.quotaProjectId ||
      ""
  ).trim();

  const gcpLocation = String(
    opts.gcpLocation || savedMeta.gcpLocation || process.env.GOOGLE_CLOUD_LOCATION || "global"
  ).trim();

  const baicodeUserTier = String(
    opts.baicodeUserTier || savedMeta.baicodeUserTier || process.env.BAICODE_USER_TIER || "gcp-ge-plus-tier"
  ).trim();

  const permissionMode = (
    opts.permissionMode ||
    (savedMeta.permissionMode as "accept-edits" | "strict") ||
    (process.env.AGY_PERMISSION_MODE as "accept-edits" | "strict") ||
    "accept-edits"
  );

  const vkAgy = String(
    opts.vkAgy || savedAuth["bifrost-agy"]?.key || process.env.BIFROST_VK_AGY || ""
  ).trim();

  const vkDefault = String(
    opts.vkDefault || savedMeta.vkDefault || savedAuth["bifrost"]?.key || process.env.BIFROST_VK_DEFAULT || ""
  ).trim();

  const bifrostPolicyUser = String(opts.bifrostPolicyUser || process.env.BIFROST_POLICY_USER || "").trim();
  const bifrostPolicyPassword = String(opts.bifrostPolicyPassword || process.env.BIFROST_POLICY_PASSWORD || "").trim();
  const defaultAgyPolicyModel = String(opts.defaultAgyPolicyModel || process.env.CENTRAL_DEFAULT_AGY_MODEL || "").trim();
  const agyBin = detectAgyBin(opts.agyBin || process.env.AGY_BIN, userHome);
  const conversationTtlMs = Number(opts.conversationTtlSeconds || process.env.CONVERSATION_TTL_SECONDS || 900) * 1000;
  const shimSharedSecret = String(opts.shimSharedSecret || process.env.SHIM_SHARED_SECRET || "").trim();
  const localBridgePort = Number(opts.localBridgePort || 8091);

  const isLocalBifrost = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(bifrostUrl);
  const resolvedRoutingMode: "through-bifrost" | "central-bifrost" =
    opts.routingMode === "through-bifrost" || opts.routingMode === "central-bifrost"
      ? opts.routingMode
      : isLocalBifrost
        ? "through-bifrost"
        : "central-bifrost";

  const allowedRoots = (
    opts.allowedWorkspaceRoots ||
    (process.env.AGY_ALLOWED_WORKSPACE_ROOTS
      ? process.env.AGY_ALLOWED_WORKSPACE_ROOTS.split(",")
      : [userHome, resolve(pluginInput.directory), "/tmp"])
  )
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => resolve(p));

  const sessionMap = new Map<string, SessionEntry>();
  const auditRing: Array<Record<string, any>> = [];
  let modelCache: Record<string, string> = {};
  let modelCacheTs = 0;
  const vkAllowCache = new Map<string, { ts: number; allowed: Set<string> }>();
  let policyRuleCache: { ts: number; model: string } = { ts: 0, model: "" };
  let latestActiveOpencodeDir = resolve(pluginInput.directory);

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
      stdout: "pipe",
      stderr: "pipe",
      env: buildAgyEnv(),
    });
    const [stdoutTxt, stderrTxt, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
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

  async function resolveCentralPolicyModel(catalog: Record<string, string>): Promise<string> {
    const now = Date.now();
    if (policyRuleCache.model && now - policyRuleCache.ts < 60_000) {
      return policyRuleCache.model;
    }
    if (bifrostPolicyUser && bifrostPolicyPassword) {
      try {
        const basic = Buffer.from(`${bifrostPolicyUser}:${bifrostPolicyPassword}`).toString("base64");
        const resp = await fetch(`${bifrostUrl}/api/routing/rules`, {
          headers: { Authorization: `Basic ${basic}` },
        });
        if (resp.ok) {
          const raw: any = await resp.json();
          const rules: any[] = Array.isArray(raw) ? raw : raw?.rules || raw?.data || [];
          rules.sort((a, b) => Number(a?.priority ?? 100) - Number(b?.priority ?? 100));
          for (const rule of rules) {
            if (rule?.enabled !== false && String(rule?.cel_expression || "").includes("policy-routed")) {
              const targetModel = String(rule?.targets?.[0]?.model || "").split("/").pop() || "";
              if (targetModel) {
                policyRuleCache = { ts: now, model: targetModel };
                return targetModel;
              }
            }
          }
        }
      } catch {
        // Fall through to configured defaultAgyPolicyModel or first discovered live model
      }
    }
    if (defaultAgyPolicyModel && catalog[defaultAgyPolicyModel]) {
      return defaultAgyPolicyModel;
    }
    const firstSlug = Object.keys(catalog)[0];
    if (!firstSlug) throw new Error("No models available in live `agy models` catalog.");
    return firstSlug;
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

      if (resolvedRoutingMode === "through-bifrost") {
        if (shimSharedSecret && bearerToken !== shimSharedSecret && req.headers.get("x-api-key") !== shimSharedSecret) {
          return Response.json(
            { error: { message: "Unauthorized direct loopback call; route through Bifrost.", type: "PluginAuthError" } },
            { status: 401 }
          );
        }
      } else {
        // central-bifrost mode: verify caller Virtual Key + CEL rule outbound against Central Bifrost
        const callerVk = bearerToken || vkAgy;
        if (!callerVk) {
          return Response.json(
            { error: { message: "Missing Bifrost Virtual Key (`opencode auth login` or `vkAgy`).", type: "PluginAuthError" } },
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
        const targetSlug =
          requestedModel === "policy-routed" ? await resolveCentralPolicyModel(catalog) : requestedModel;
        if (!vkCheck.allowed.has("*") && (!vkCheck.allowed.has(requestedModel) || !vkCheck.allowed.has(targetSlug))) {
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

      // Streaming SSE path
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
          "Connection": "keep-alive",
          "x-agy-runtime": "in-process-opencode-plugin",
          "x-agy-conversation-resumed": String(Boolean(resumedConvoId)),
        },
      });
    }

    return Response.json({ error: { message: `Not found: ${path}` } }, { status: 404 });
  }

  // Start embedded loopback server inside OpenCode's Bun runtime (port 8091 for through-bifrost, ephemeral port 0 for central-bifrost)
  const desiredPort = resolvedRoutingMode === "through-bifrost" ? localBridgePort : 0;
  let embeddedServer: ReturnType<typeof Bun.serve> | null = null;
  try {
    embeddedServer = Bun.serve({
      hostname: "127.0.0.1",
      port: desiredPort,
      idleTimeout: 255,
      fetch: handleBridgeRequest,
    });
  } catch {
    // If port 8091 is already bound by another OpenCode window, bind an ephemeral port cleanly
    embeddedServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 255,
      fetch: handleBridgeRequest,
    });
  }
  embeddedServer.unref();

  return {
    dispose: async () => {
      if (embeddedServer) {
        embeddedServer.stop(true);
        embeddedServer = null;
      }
    },

    auth: {
      provider: "bifrost-agy",
      methods: [
        {
          type: "api",
          label: "Configure Bifrost Gateway + Gemini Enterprise Seat",
          prompts: [
            {
              type: "text",
              key: "bifrostUrl",
              message: "Bifrost Gateway URL",
              placeholder: "https://bifrost.internal.example.com (or http://127.0.0.1:8080)",
              validate: (v) => (/^https?:\/\/.+/.test(v.trim()) ? undefined : "Enter a valid http:// or https:// URL"),
            },
            {
              type: "text",
              key: "vkAgy",
              message: "Bifrost Virtual Key for /agy (Gemini Enterprise)",
              placeholder: "sk-bf-agy-...",
              validate: (v) => (v.trim().length > 3 ? undefined : "Required"),
            },
            {
              type: "text",
              key: "vkDefault",
              message: "Bifrost Standard Virtual Key (for default coding turns)",
              placeholder: "sk-bf-oc-...",
              validate: (v) => (v.trim().length > 3 ? undefined : "Required"),
            },
            {
              type: "text",
              key: "gcpProjectId",
              message: "Gemini Enterprise GCP Quota Project ID",
              placeholder: adcInfo.quotaProjectId || "your-gcp-project-id",
              validate: (v) => (v.trim().length > 2 ? undefined : "Required"),
            },
            {
              type: "select",
              key: "gcpLocation",
              message: "Gemini Enterprise Location",
              options: [
                { label: "global (Default)", value: "global" },
                { label: "us (Multi-region)", value: "us" },
                { label: "eu (Multi-region)", value: "eu" },
              ],
            },
            {
              type: "select",
              key: "baicodeUserTier",
              message: "Gemini Enterprise License Tier (for Developer Tools Metrics)",
              options: [
                { label: "Gemini Enterprise Plus (gcp-ge-plus-tier)", value: "gcp-ge-plus-tier" },
                { label: "Gemini Enterprise Standard (gcp-ge-standard-tier)", value: "gcp-ge-standard-tier" },
              ],
            },
            {
              type: "select",
              key: "permissionMode",
              message: "Headless Antigravity Workspace Permission Posture",
              options: [
                { label: "accept-edits (Recommended — edits allowed in repo; bash & external reads prompt in OpenCode)", value: "accept-edits" },
                { label: "strict (Prompt in OpenCode for file writes, bash, and external reads)", value: "strict" },
              ],
            },
          ],
          authorize: async (inputs = {}) => {
            const url = String(inputs.bifrostUrl || bifrostUrl).replace(/\/+$/, "");
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

    config: async (cfg) => {
      cfg.provider = cfg.provider || {};
      cfg.agent = cfg.agent || {};
      cfg.command = cfg.command || {};

      // 1. Discover standard Bifrost models dynamically using vkDefault
      const standardModels: Record<string, { name: string }> = {};
      if (vkDefault) {
        try {
          const r = await fetch(`${bifrostUrl}/v1/models`, {
            headers: { Authorization: `Bearer ${vkDefault}` },
          });
          if (r.ok) {
            const data = (await r.json()) as { data?: Array<{ id?: string }> };
            for (const m of data.data || []) {
              const id = String(m?.id || "");
              if (id && !id.startsWith("agy-cli/")) {
                standardModels[id] = { name: `${id} (Bifrost)` };
              }
            }
          }
        } catch {
          // Non-fatal during offline startup
        }
      }

      if (vkDefault || Object.keys(standardModels).length > 0) {
        cfg.provider["bifrost"] = {
          npm: "@ai-sdk/openai-compatible",
          name: "Bifrost AI Gateway",
          options: {
            baseURL: `${bifrostUrl}/v1`,
            apiKey: vkDefault || "{env:BIFROST_VK_DEFAULT}",
          },
          models: standardModels,
        } as any;

        const firstStdId = Object.keys(standardModels)[0];
        const firstStdModel = opts.defaultCodingModel || (firstStdId ? `bifrost/${firstStdId}` : undefined);
        if (firstStdModel && !cfg.model) {
          cfg.model = firstStdModel;
          cfg.small_model = cfg.small_model || firstStdModel;
        }
      }

      // 2. Discover live Antigravity CLI models + Bifrost aliases & intersect with vkAgy allowlist
      const agyModelsConfig: Record<string, { name: string }> = {
        "agy-cli/policy-routed": {
          name: "Antigravity CLI — Bifrost Policy-Configured Model (Gemini Enterprise)",
        },
      };
      const discoveredAliases: string[] = [];
      try {
        const liveAgyCatalog = await discoverAgyModels(false);
        let allowedSet: Set<string> | null = null;
        if (vkAgy) {
          const check = await validateCentralVirtualKey(vkAgy);
          if (check.status === 200 && check.allowed.size > 0 && !check.allowed.has("*")) {
            allowedSet = check.allowed;
            for (const slug of check.allowed) {
              if (!liveAgyCatalog[slug] && slug !== "policy-routed" && slug !== "*") {
                agyModelsConfig[`agy-cli/${slug}`] = {
                  name: `Antigravity CLI — Bifrost Alias '${slug}' (Gemini Enterprise)`,
                };
                if (slug.startsWith("agy-")) {
                  discoveredAliases.push(slug);
                }
              }
            }
          }
        }
        for (const [slug, displayName] of Object.entries(liveAgyCatalog)) {
          if (!allowedSet || allowedSet.has(slug)) {
            agyModelsConfig[`agy-cli/${slug}`] = {
              name: `Antigravity — ${displayName} (Gemini Enterprise)`,
            };
          }
        }
      } catch {
        // Keep policy-routed registered even if ADC login hasn't been completed yet so /agy-doctor works
      }

      const agyBaseUrl =
        resolvedRoutingMode === "through-bifrost" && embeddedServer?.port === localBridgePort
          ? `${bifrostUrl}/v1`
          : `http://127.0.0.1:${embeddedServer?.port}/v1`;

      cfg.provider["bifrost-agy"] = {
        npm: "@ai-sdk/openai-compatible",
        name: "Antigravity CLI (Bifrost Policy + Gemini Enterprise Plugin)",
        options: {
          baseURL: agyBaseUrl,
          apiKey: vkAgy || "{env:BIFROST_VK_AGY}",
        },
        models: agyModelsConfig,
      } as any;

      cfg.enabled_providers = Array.from(new Set([...(cfg.enabled_providers || []), "bifrost", "bifrost-agy"]));

      for (const stdAgent of ["build", "plan", "general", "explore"]) {
        cfg.agent[stdAgent] = {
          ...(cfg.model ? { model: cfg.model } : {}),
          permission: { antigravity: "deny" },
          ...(cfg.agent[stdAgent] || {}),
        } as any;
      }

      cfg.agent["agy"] = {
        description: "Policy-governed Antigravity CLI agent via Gemini Enterprise (Zero-Daemon Plugin)",
        mode: "all",
        model: "bifrost-agy/agy-cli/policy-routed",
        permission: { antigravity: "allow" },
        ...(cfg.agent["agy"] || {}),
      } as any;

      cfg.command["agy"] = {
        description: "Execute via Antigravity CLI using Bifrost's active model policy (Gemini Enterprise)",
        agent: "agy",
        model: "bifrost-agy/agy-cli/policy-routed",
        template: "$ARGUMENTS",
        ...(cfg.command["agy"] || {}),
      } as any;

      for (const alias of discoveredAliases) {
        cfg.command[alias] = {
          description: `Execute via Antigravity CLI using Bifrost alias '${alias}' (Gemini Enterprise)`,
          agent: "agy",
          model: `bifrost-agy/agy-cli/${alias}`,
          template: "$ARGUMENTS",
          ...(cfg.command[alias] || {}),
        } as any;
      }

      cfg.command["agy-doctor"] = {
        description: "Verify Antigravity CLI, Gemini Enterprise ADC seat, BAICODE_USER_TIER, and Bifrost Gateway connectivity",
        template: "Call the `agy_doctor` tool and present a concise readiness table.",
      } as any;
    },

    "chat.headers": async (input, output) => {
      latestActiveOpencodeDir = resolve(pluginInput.directory);
      output.headers["x-opencode-session-id"] = input.sessionID;
      output.headers["x-opencode-workspace-dir"] = latestActiveOpencodeDir;
    },

    tool: {
      agy_doctor: tool({
        description:
          "Runs a live preflight check across Antigravity CLI (`agy`), Google Cloud human ADC (`authorized_user`), Gemini Enterprise `BAICODE_USER_TIER`, and Bifrost Gateway Virtual Key RBAC.",
        args: {},
        async execute(_args, context) {
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
          const vkStatus = vkAgy ? await validateCentralVirtualKey(vkAgy) : { status: 0, allowed: new Set<string>(), error: "vkAgy unset" };
          return JSON.stringify(
            {
              plugin_runtime: "opencode-bifrost-agy@1.0.0 (in-process, zero external daemons)",
              routing_mode: resolvedRoutingMode,
              embedded_bridge_port: embeddedServer?.port || null,
              active_workspace: context.directory,
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
            },
            null,
            2
          );
        },
      }),
    },
  };
};
