#!/usr/bin/env node
/**
 * generate_mcp_server.js
 * ----------------------------------------------------------------------------
 * 从 REST API（OpenAPI 3.x 规范，或手动端点清单）生成一个「可直接发布到 GitHub」
 * 的 MCP server 仓库（stdio 传输，Node + TypeScript，@modelcontextprotocol/sdk）。
 *
 * 用法：
 *   node generate_mcp_server.js --spec openapi.json \
 *        --name "My API MCP" --pkg my-api-mcp --out ./out/my-api-mcp
 *
 *   # 远端规范
 *   node generate_mcp_server.js --spec-url https://x.com/openapi.json --pkg my-api-mcp --out ./out
 *
 *   # 手动端点清单（不依赖 OpenAPI）
 *   node generate_mcp_server.js --manual endpoints.json --out ./out
 *
 *   # 生成后自动安装依赖 + 编译 + 握手自检 + 质量门禁审计
 *   node generate_mcp_server.js --spec openapi.json --pkg my-api-mcp --out ./out --install --self-check --audit
 *
 *   # 仅对已生成的仓库做质量门禁审计（不重新生成）
 *   node generate_mcp_server.js --audit ./out/my-api-mcp
 * ----------------------------------------------------------------------------
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const TEMPLATES = path.join(__dirname, "..", "templates");

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

const USAGE = `rest-api-to-mcp — 把 REST API 生成 MCP server 或 WorkBuddy skill 包

用法:
  node generate_mcp_server.js --spec <文件> [--out <目录>] [选项]
  node generate_mcp_server.js --spec-url <URL> [--out <目录>] [选项]
  node generate_mcp_server.js --manual <清单.json> [--out <目录>] [选项]
  node generate_mcp_server.js --audit <已生成的目录>     仅做质量门禁

输入（三选一）:
  --spec <文件>        OpenAPI 3.x / Swagger 2.0 规范文件（JSON，或 YAML 需 pyyaml）
  --spec-url <URL>     远端规范地址，自动下载后解析
  --manual <文件>      手写端点清单（无需 OpenAPI，见 SKILL.md「手动清单格式」）

输出:
  --out <目录>         输出目录（生成新仓库时必填）
  --mode mcp|skill     产出形态，默认 mcp
                         mcp   = Node + TypeScript，stdio MCP server
                         skill = WorkBuddy skill 包（SKILL.md + Python 零依赖脚本）
  --pkg <包名>         生成的 package.json name / skill 目录名，默认由标题推导

可选:
  --install            生成后执行 npm install
  --self-check         生成后做 stdio 握手自检（隐含需要 --install）
  --audit              生成后跑质量门禁（合规/安全/可用性三栏）
  --base-url <URL>     覆盖规范里的 servers[0].url
  --auth-env <NAME>    鉴权密钥所在环境变量名
  --auth-header <H>    鉴权头名称，如 X-API-Key
  --auth-template <T>  鉴权头取值模板，如 "Bearer \${TOKEN}"
  --force              输出目录非空时允许覆盖
  -h, --help           显示本帮助
`;

const args = parseArgs(process.argv);

if (args.help || args.h || args["?"]) {
  console.log(USAGE);
  process.exit(0);
}

// 支持 `--audit <目录>` 直接把目录当作审计目标（解析器会把目录当成 --audit 的值）
if (typeof args.audit === "string" && !args.out) {
  args.out = args.audit;
  args.audit = true;
}

function die(msg) {
  console.error("❌ " + msg);
  process.exit(1);
}

if (!args.spec && !args["spec-url"] && !args.manual && !args.audit) {
  die("必须提供 --spec <文件> / --spec-url <URL> / --manual <文件> 之一（或仅做审计时给 --audit <目录>）");
}
if (!args.out) die("--out <输出目录> 必填");

const MODE = (args.mode || "mcp").toLowerCase();
if (!["mcp", "skill"].includes(MODE)) die("--mode 只能是 mcp 或 skill（默认 mcp）");
args.mode = MODE;

// ---------------------------------------------------------------------------
// 规范加载（JSON / YAML）
// ---------------------------------------------------------------------------
function ensureYaml(py) {
  const t = spawnSync(py, ["-c", "import yaml"], { encoding: "utf8" });
  if (t.status === 0) return true;
  const i = spawnSync(py, ["-m", "pip", "install", "--quiet", "pyyaml"], { encoding: "utf8" });
  return i.status === 0;
}

function yamlToJson(file) {
  const candidates = [
    "python3",
    "python",
    "C:/Users/hupan/.workbuddy/binaries/python/envs/default/Scripts/python.exe",
    "C:/Users/hupan/.workbuddy/binaries/python/versions/3.13.12/python3",
  ];
  const code = "import yaml,json,sys;print(json.dumps(yaml.safe_load(open(sys.argv[1]).read())))";
  for (const py of candidates) {
    if (!ensureYaml(py)) continue;
    const r = spawnSync(py, ["-c", code, file], { encoding: "utf8" });
    if (r.status === 0 && r.stdout && r.stdout.trim()) {
      return r.stdout;
    }
  }
  die("未找到可用的 python（需 pyyaml）来解析 YAML 规范；请改用 JSON，或先 `python -m pip install pyyaml`");
}

async function loadSpec() {
  let raw;
  let source;
  if (args["spec-url"]) {
    source = args["spec-url"];
    const r = await fetch(source);
    if (!r.ok) die("下载规范失败: " + r.status + " " + source);
    raw = await r.text();
  } else {
    source = args.spec || args.manual;
    if (!fs.existsSync(source)) die("文件不存在: " + source);
    raw = fs.readFileSync(source, "utf8");
  }
  const lower = String(source).toLowerCase();
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) {
    raw = yamlToJson(source);
  }
  // 若是手动端点清单
  if (args.manual) {
    const m = JSON.parse(raw);
    return { manual: m };
  }
  try {
    return { spec: JSON.parse(raw) };
  } catch (e) {
    die("规范不是合法 JSON（YAML 需 pyyaml 转换）: " + e.message);
  }
}

// ---------------------------------------------------------------------------
// $ref 解析（仅支持组件内简单引用）
// ---------------------------------------------------------------------------
function resolveRef(spec, node) {
  if (node && node.$ref) {
    const parts = node.$ref.replace(/^#\//, "").split("/");
    let cur = spec;
    for (const p of parts) cur = cur ? cur[p] : undefined;
    return cur || node;
  }
  return node;
}

// ---------------------------------------------------------------------------
// 规范 → 元数据 + 鉴权 + 工具列表
// ---------------------------------------------------------------------------
function sanitizeToolName(s, used) {
  let n = String(s)
    // camelCase / PascalCase 先分词，避免 operationId 被压成 getpetbyid
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!n) n = "tool";
  let uniq = n;
  let i = 2;
  while (used.has(uniq)) uniq = n + "_" + i++;
  used.add(uniq);
  return uniq;
}

function parseSecurity(spec, override) {
  // 返回 { kind:'header'|'bearer'|'query'|'none', headerName, queryName, env }
  if (override && (override.env || override.header || override.valueTemplate || override.query)) {
    const o = override;
    if (o.query) return { kind: "query", queryName: o.query, env: o.env || "API_KEY" };
    if (o.header) {
      const isBearer = /bearer/i.test(o.header) || /bearer/i.test(o.valueTemplate || "");
      return {
        kind: isBearer ? "bearer" : "header",
        headerName: o.header,
        env: o.env || "API_KEY",
      };
    }
  }
  const schemes = (spec.components && spec.components.securitySchemes) || {};
  const names = Object.keys(schemes);
  if (!names.length) return { kind: "none" };
  const s = schemes[names[0]];
  if (s.type === "apiKey") {
    if (s.in === "query") return { kind: "query", queryName: s.name, env: "API_KEY" };
    return { kind: "header", headerName: s.name, env: "API_KEY" };
  }
  if (s.type === "http" && /bearer/i.test(s.scheme || "")) {
    return { kind: "bearer", headerName: "Authorization", env: "API_KEY" };
  }
  if (s.type === "http") {
    return { kind: "header", headerName: "Authorization", env: "API_KEY" };
  }
  return { kind: "none" };
}

function opToTool(spec, path, method, op, used) {
  const rawId = op.operationId || method + "_" + path;
  // 工具名直接用 operationId 派生；同一 server 仅封装一个 API，命名空间由客户端（mcp__<server>__）负责，
  // 不再叠加 <pkg>_ 前缀，避免双重前缀与冗长。
  const toolName = sanitizeToolName(rawId, used);
  const summary = op.summary || "";
  const description = op.description || summary || (method.toUpperCase() + " " + path);
  const desc = (summary + (op.description ? "\n\n" + op.description : "")).trim() || description;

  const allParams = [];
  const queryParams = [];
  for (const p of op.parameters || []) {
    const rp = resolveRef(spec, p);
    if (!rp || !rp.name) continue;
    allParams.push({
      name: rp.name,
      in: rp.in,
      required: !!rp.required,
      description: rp.description || "",
      schema: rp.schema || {},
    });
    if (rp.in === "query") queryParams.push(rp.name);
  }

  let hasBody = false;
  if (op.requestBody) {
    const rb = resolveRef(spec, op.requestBody);
    const ct = (rb.content && (rb.content["application/json"] || rb.content["application/x-www-form-urlencoded"])) || null;
    if (ct) {
      hasBody = true;
      allParams.push({ name: "body", in: "body", required: false, description: "JSON request body object (application/json)", schema: {} });
    }
  }

  return {
    toolName,
    method: method.toUpperCase(),
    path,
    description: desc,
    allParams,
    queryParams,
    hasBody,
  };
}

function buildFromSpec(spec) {
  const info = spec.info || {};
  const title = info.title || args.name || "API";
  const version = info.version || "1.0.0";
  const description = info.description || title;
  const baseUrl =
    args["base-url"] ||
    (spec.servers && spec.servers[0] && spec.servers[0].url) ||
    (spec.host ? (spec.schemes ? spec.schemes[0] + "://" : "https://") + spec.host + (spec.basePath || "") : "https://api.example.com");
  const pkg = args.pkg || sanitizePkg(title);
  const auth = parseSecurity(spec, args.auth ? JSON.parse(args.auth) : null);

  const used = new Set();
  const tools = [];
  const paths = spec.paths || {};
  const methods = ["get", "post", "put", "patch", "delete"];
  for (const p of Object.keys(paths)) {
    const item = paths[p] || {};
    for (const m of methods) {
      if (item[m]) tools.push(opToTool(spec, p, m, item[m], used));
    }
  }
  return { title, version, description, baseUrl, pkg, auth, tools, source: "openapi" };
}

// 把手动清单里的参数项（字符串简称 or 对象）规范成 {name,in,required,description,schema}
// 支持对象形式声明类型：{ name, type:"integer"|"number"|"boolean"|"array"|"string", enum:[...], description, required }
function normManualParam(p, defIn, defReq) {
  if (typeof p === "string") {
    return { name: p, in: defIn, required: defReq, description: "", schema: {} };
  }
  const type = p.type || "string";
  const schema = { type };
  if (Array.isArray(p.enum) && p.enum.length) schema.enum = p.enum;
  return {
    name: p.name,
    in: p.in || defIn,
    required: p.required !== undefined ? !!p.required : defReq,
    description: p.description || "",
    schema,
  };
}

function buildFromManual(m) {
  const title = m.name || args.name || "API";
  const version = m.version || "1.0.0";
  const description = m.description || title;
  const baseUrl = args["base-url"] || m.baseUrl || "https://api.example.com";
  const pkg = args.pkg || m.pkg || sanitizePkg(title);
  const auth = parseSecurity({}, m.auth);
  const used = new Set();
  const tools = (m.tools || []).map((t) => {
    const allParams = (t.pathParams || []).map((p) => normManualParam(p, "path", true));
    const queryParams = t.queryParams || [];
    for (const q of queryParams) allParams.push(normManualParam(q, "query", false));
    if (t.body) allParams.push({ name: "body", in: "body", required: false, description: "JSON request body", schema: {} });
    return {
      toolName: sanitizeToolName(t.name || (t.method + "_" + t.path), used),
      method: (t.method || "GET").toUpperCase(),
      path: t.path,
      description: t.description || (t.method || "GET") + " " + t.path,
      allParams,
      queryParams,
      hasBody: !!t.body,
    };
  });
  return { title, version, description, baseUrl, pkg, auth, tools, source: "manual" };
}

function sanitizePkg(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "api-mcp";
}

// ---------------------------------------------------------------------------
// 工具注册代码生成（.ts）
// ---------------------------------------------------------------------------
function buildToolRegistration(t) {
  const lines = [];
  for (const p of t.allParams) {
    if (p.in === "body") {
      lines.push('      body: z.any().optional().describe("JSON request body object (application/json)"),');
      continue;
    }
    const name = p.name;
    const desc = p.description || (p.in === "path" ? "path parameter" : "query parameter");
    const en = p.schema && p.schema.enum;
    let ctor = "z.string()";
    if (Array.isArray(en) && en.length && en.every((v) => typeof v === "string")) {
      // 枚举优先：保持 z.enum 强约束
      ctor = "z.enum([" + en.map((v) => JSON.stringify(v)).join(", ") + "])";
    } else {
      // 类型保真：依据 OpenAPI schema.type 映射 zod（query/path 在 URL 里本是字符串，
      // 用 z.coerce 让调用方可以传数字/布尔，生成器在 buildUrl 里再规整为字符串）。
      const ty = (p.schema && p.schema.type) || "string";
      if (ty === "integer" || ty === "number") ctor = "z.coerce.number()";
      else if (ty === "boolean") ctor = "z.coerce.boolean()";
      else if (ty === "array") ctor = "z.array(z.string())";
      else ctor = "z.string()";
    }
    const opt = p.required ? "" : ".optional()";
    lines.push(
      "      " +
        JSON.stringify(name) +
        ": " +
        ctor +
        opt +
        ".describe(" +
        JSON.stringify(desc) +
        "),"
    );
  }
  const paramsBlock = lines.length ? lines.join("\n") : "      ";
  // buildUrl 要的是「参数名数组」，无论 queryParams 元素是字符串还是对象，都只取 name
  const queryNames = (t.queryParams || []).map((q) => (typeof q === "string" ? q : q.name));
  const queryList = queryNames.length ? ", " + JSON.stringify(queryNames) : "";
  const bodyFlag = t.hasBody ? ", true" : "";
  // 借鉴 cn-mcp-builder：用 MCP 标准 Tool Annotations 声明工具行为（比描述文本更规范，客户端可直接识别只读/破坏性）。
  // 关键：MCP 默认 destructiveHint=true，必须显式把非破坏性声明为 false，否则所有工具都会被当成“破坏性”导致客户端过度拦截。
  const annotations = {
    readOnlyHint: t.method === "GET", // GET = 只读
    destructiveHint: t.method === "DELETE", // 仅 DELETE 声明破坏性
    idempotentHint: t.method !== "POST", // POST 不幂等，其余（GET/PUT/PATCH/DELETE）幂等
    openWorldHint: true, // 均与外部 API 交互
  };
  return (
    "  server.tool(\n" +
    "    " +
    JSON.stringify(t.toolName) +
    ",\n" +
    "    " +
    JSON.stringify(t.description) +
    ",\n" +
    "    {\n" +
    paramsBlock +
    "\n" +
    "    },\n" +
    "    " +
    JSON.stringify(annotations) +
    ",\n" +
    "    async (args) => {\n" +
    "      try {\n" +
    "        const url = buildUrl(" +
    JSON.stringify(t.path) +
    ", args" +
    queryList +
    ");\n" +
    "        const res = await callApi(" +
    JSON.stringify(t.method) +
    ", url, args" +
    bodyFlag +
    ");\n" +
    "        let data: unknown = res;\n" +
    "        try { data = JSON.parse(res); } catch { /* 非 JSON 响应则保留原文 */ }\n" +
    "        return { content: [{ type: \"text\", text: res }], structuredContent: { data } };\n" +
    "      } catch (e) {\n" +
    "        const msg = e instanceof Error ? e.message : String(e);\n" +
    "        return { content: [{ type: \"text\", text: \"Error: \" + msg + \"\\n\\n排查建议：检查参数格式、API_BASE_URL、网络连通性，以及 env 中是否已注入鉴权密钥。\" }], isError: true };\n" +
    "      }\n" +
    "    }\n" +
    "  );"
  );
}

// ---------------------------------------------------------------------------
// 鉴权片段
// ---------------------------------------------------------------------------
function authHeaderLines(auth) {
  if (auth.kind === "header") {
    return '  h[' + JSON.stringify(auth.headerName) + '] = (process.env.' + auth.env + ' || "");';
  }
  if (auth.kind === "bearer") {
    return '  h[' + JSON.stringify(auth.headerName) + '] = "Bearer " + (process.env.' + auth.env + ' || "");';
  }
  return "";
}
function authQueryLine(auth) {
  if (auth.kind === "query") {
    return "  if (process.env." + auth.env + ") q.set(" + JSON.stringify(auth.queryName) + ", process.env." + auth.env + ");";
  }
  return "";
}

// ---------------------------------------------------------------------------
// 模板渲染
// ---------------------------------------------------------------------------
function render(templateText, map) {
  return templateText.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in map ? map[k] : "{{" + k + "}}"));
}

function readTemplate(rel) {
  return fs.readFileSync(path.join(TEMPLATES, rel), "utf8");
}

// ---------------------------------------------------------------------------
// 写仓库
// ---------------------------------------------------------------------------
function writeRepo(data) {
  const outDir = path.resolve(args.out);
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(outDir, "src"), { recursive: true });
  const { title, version, description, baseUrl, pkg, auth, tools } = data;

  const toolRegs = tools.map(buildToolRegistration).join("\n\n");
  const toolsTable =
    tools.length
      ? ["| Tool | Method | Path | Description |", "| --- | --- | --- | --- |"]
          .concat(
            tools.map(
              (t) =>
                "| `" +
                t.toolName +
                "` | " +
                t.method +
                " | `" +
                t.path +
                "` | " +
                String(t.description).replace(/\|/g, "\\|").split("\n")[0].slice(0, 80) +
                " |"
            )
          )
          .join("\n")
      : "_（本规范未包含可映射的操作；请检查 paths 或改用 --manual）_";

  const map = {
    SERVER_NAME: title,
    PKG_NAME: pkg,
    VERSION: version,
    TOOL_COUNT: tools.length,
    SPEC_DESC: description,
    BASE_URL: baseUrl,
    OUT_ABS: outDir,
    AUTH_ENV: auth.env || "API_KEY",
    AUTH_HEADER_LINES: authHeaderLines(auth),
    AUTH_QUERY_LINE: authQueryLine(auth),
    TOOL_REGISTRATIONS: toolRegs,
    TOOLS_TABLE: toolsTable,
    YEAR: new Date().getFullYear(),
    AUTHOR: args.author || "API MCP Generator",
  };

  const writes = [
    ["package.json.template", "package.json"],
    ["tsconfig.json.template", "tsconfig.json"],
    ["src/index.ts.template", "src/index.ts"],
    ["src/api-client.ts.template", "src/api-client.ts"],
    ["src/tools.ts.template", "src/tools.ts"],
    ["README.md.template", "README.md"],
    [".gitignore", ".gitignore"],
    ["LICENSE.template", "LICENSE"],
    [".env.example.template", ".env.example"],
    ["Dockerfile.template", "Dockerfile"],
    ["mcp_config.example.json.template", "mcp_config.example.json"],
  ];

  for (const [from, to] of writes) {
    const txt = render(readTemplate(from), map);
    fs.writeFileSync(path.join(outDir, to), txt, "utf8");
  }

  console.log("✅ 仓库已生成：" + outDir);
  console.log("   - 工具数：" + tools.length);
  console.log("   - 包名：" + pkg + "  |  鉴权：" + auth.kind + (auth.headerName ? " (" + auth.headerName + ")" : ""));
  console.log("   - 入口：node build/index.js（本地源码包；若已 npm publish 可改用 npx -y " + pkg + "）");
  return outDir;
}

// ---------------------------------------------------------------------------
// Skill 模式：产出 WorkBuddy skill 包（ucsc-genome-api 风格，Python 零依赖）
// ---------------------------------------------------------------------------
function pythonAuth(auth) {
  const env = (auth && auth.env) || "";
  if (!auth || auth.kind === "none") return { env: "", headerName: "", prefix: "", query: "" };
  if (auth.kind === "bearer") return { env, headerName: auth.headerName || "Authorization", prefix: "Bearer ", query: "" };
  if (auth.kind === "query") return { env, headerName: "", prefix: "", query: auth.queryName || "api_key" };
  return { env, headerName: auth.headerName || "X-API-Key", prefix: "", query: "" };
}

function buildEndpoints(tools) {
  const STOP = new Set([
    "a", "an", "the", "in", "of", "to", "for", "by", "with", "and", "or",
    "is", "are", "from", "all", "its", "that", "this", "on", "at", "as",
    "be", "your", "you", "we", "our", "single", "one", "new", "into",
  ]);
  return tools.map((t) => {
    const kws = new Set();
    t.toolName.split(/[_\s]+/).forEach((w) => { if (w) kws.add(w.toLowerCase()); });
    t.path.replace(/[{}]/g, "").split("/").forEach((s) => {
      const w = s.trim();
      if (w && !/^\d+$/.test(w)) kws.add(w.toLowerCase());
    });
    // 把 description 里的实词也纳入关键词，显著提升 prompt→端点的区分度
    String(t.description).split(/[\s\-]+/).forEach((w) => {
      w = w.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (w && w.length > 1 && !STOP.has(w)) kws.add(w);
    });
    return {
      method: t.method,
      path: t.path,
      description: String(t.description).split("\n")[0].replace(/\|/g, "\\|").slice(0, 120),
      keywords: Array.from(kws).slice(0, 20),
    };
  });
}

function writeSkillRepo(data) {
  const outDir = path.resolve(args.out);
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(outDir, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(outDir, "references"), { recursive: true });

  const { title, baseUrl, pkg, auth, tools } = data;
  const skillName = sanitizePkg(pkg) + "-skill";
  const pa = pythonAuth(auth);
  const endpoints = buildEndpoints(tools);
  const exampleEndpoint = tools.length ? tools[0].path.replace(/^\//, "") : "";
  const authNote = auth.kind === "none" ? " (no auth required)" : " (set this before running the script)";

  const skillMap = {
    SKILL_NAME: skillName,
    SERVER_NAME: title,
    BASE_URL: baseUrl,
    AUTH_ENV: pa.env || "API_KEY",
    AUTH_NOTE: authNote,
    EXAMPLE_ENDPOINT: exampleEndpoint,
    SOURCE: title,
  };
  const pyMap = {
    SOURCE: title,
    BASE_URL: baseUrl,
    AUTH_ENV: pa.env || "",
    AUTH_HEADER_NAME: pa.headerName || "",
    AUTH_HEADER_PREFIX: pa.prefix || "",
    AUTH_QUERY_PARAM: pa.query || "",
    ENDPOINTS: JSON.stringify(endpoints, null, 2),
  };
  const quickMap = {
    SERVER_NAME: title,
    BASE_URL: baseUrl,
    AUTH_ENV: pa.env || "API_KEY",
    AUTH_NOTE: authNote,
    ENDPOINT_ROWS: tools.length
      ? tools
          .map(
            (t) =>
              "| " + t.method + " | `" + t.path + "` | " +
              String(t.description).split("\n")[0].replace(/\|/g, "\\|").slice(0, 100) + " |"
          )
          .join("\n")
      : "| GET | `/` | (no endpoints parsed) |",
  };
  const baseMap = { YEAR: new Date().getFullYear(), AUTHOR: args.author || "API MCP Generator" };

  const writes = [
    { from: "skill/SKILL.md.template", to: "SKILL.md", map: skillMap },
    { from: "skill/scripts/query_api.py.template", to: "scripts/query_api.py", map: pyMap },
    { from: "skill/references/api_quickref.md.template", to: "references/api_quickref.md", map: quickMap },
    { from: "skill/.gitignore", to: ".gitignore", map: {} },
    { from: "LICENSE.template", to: "LICENSE", map: baseMap },
  ];
  for (const w of writes) {
    fs.writeFileSync(path.join(outDir, w.to), render(readTemplate(w.from), w.map), "utf8");
  }

  console.log("✅ Skill 包已生成：" + outDir);
  console.log("   - 端点数：" + tools.length);
  console.log("   - 包名：" + skillName + "  |  鉴权：" + auth.kind + (pa.headerName ? " (" + pa.headerName + ")" : ""));
  console.log("   - 放入 WorkBuddy skills 目录（如 ~/.workbuddy/skills/" + skillName + "）即可被加载");
  return outDir;
}

function findPython() {
  const cands = [
    "python3",
    "python",
    "C:/Users/hupan/.workbuddy/binaries/python/envs/default/Scripts/python.exe",
  ];
  for (const py of cands) {
    const r = spawnSync(py, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return py;
  }
  return null;
}

function runSkillSelfCheck(outDir, data) {
  console.log("\n=== skill 模式自检 ===");
  const py = findPython();
  if (!py) {
    console.log("⚠️ 未找到 python，跳过脚本 --help 自检（请自行确认 python 可用；脚本仅用标准库，无需 requests）");
    return;
  }
  const r = spawnSync(py, ["scripts/query_api.py", "--help"], { cwd: outDir, encoding: "utf8" });
  if (r.status === 0) {
    console.log("✅ 脚本 --help 正常，skill 包可用（含 " + data.tools.length + " 个端点，标准库零依赖）。");
  } else {
    console.log("⚠️ 脚本 --help 异常，输出：\n" + ((r.stdout || "") + (r.stderr || "")).slice(0, 600));
  }
}

// ---------------------------------------------------------------------------
// 安装 + 编译 + 握手自检（MCP 模式）
// ---------------------------------------------------------------------------
function runInstallAndCheck(outDir) {
  const hasNodeModules = fs.existsSync(path.join(outDir, "node_modules"));
  console.log("\n=== npm install ===");
  let inst;
  if (hasNodeModules) {
    console.log("（node_modules 已存在，跳过 install，直接复用）");
    inst = { status: 0 };
  } else {
    for (let attempt = 1; attempt <= 3; attempt++) {
      // 用 shell:true 让系统 shell 解析 npm(.cmd)，退出码才能正确传播（Windows 直调 .cmd 会丢退出码）
      inst = spawnSync("npm", ["install"], { cwd: outDir, stdio: "inherit", shell: true });
      if (inst.status === 0) break;
      console.log("⚠️ npm install 第 " + attempt + " 次失败，自动重试（最多 3 次）…");
    }
    if (inst.status !== 0) {
      die("npm install 失败（已重试 3 次，疑似网络/registry 抖动；可手动在输出目录执行 npm install 后重新运行本命令）");
    }
  }
  console.log("=== npm run build ===");
  // 清掉旧 build 产物，避免增量/残留干扰
  try { fs.rmSync(path.join(outDir, "build"), { recursive: true, force: true }); } catch (e) {}
  const b = spawnSync("npm", ["run", "build"], { cwd: outDir, stdio: "inherit", shell: true });
  if (b.status !== 0) die("tsc 编译失败");

  console.log("=== 握手自检 (initialize + tools/list) ===");
  const h = handshakeProbe(outDir);
  if (h.ok) {
    console.log("✅ 握手成功，服务器返回工具：" + (h.names.length ? h.names.join(", ") : "(空)"));
  } else {
    console.log("⚠️ 未检测到 tools/list 响应，原始输出：\n" + h.raw.slice(0, 800));
  }
}

// 起 node build/index.js 发 initialize → tools/list，返回 {ok, names, raw}
function handshakeProbe(outDir) {
  const proc = spawnSync(
    "node",
    ["build/index.js"],
    {
      cwd: outDir,
      encoding: "utf8",
      timeout: 30000,
      input:
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "probe", version: "1.0" } } }) +
        "\n" +
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
        "\n" +
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) +
        "\n",
    }
  );
  const raw = (proc.stdout || "") + (proc.stderr || "");
  // 逐行解析 JSON-RPC 响应，取 id=2 的 tools/list 结果。
  // 不要用 /"name"\s*:\s*"..." 之类的正则——那会抓到对象键名（永远是 "name"）。
  let names = [];
  let sawToolsList = false;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const msg = JSON.parse(t);
      if (msg && msg.id === 2 && msg.result && Array.isArray(msg.result.tools)) {
        sawToolsList = true;
        names = msg.result.tools.map((x) => x && x.name).filter(Boolean);
      }
    } catch (e) {
      // 非 JSON 行（日志/警告）忽略
    }
  }
  if (!sawToolsList) {
    // 兜底：至少确认有 tools 数组出现
    const m = raw.match(/"tools"\s*:\s*\[/);
    if (m) sawToolsList = true;
  }
  return { ok: sawToolsList, names, raw };
}

// ---------------------------------------------------------------------------
// 质量门禁（--audit）：按「合规 / 安全 / 可用性」三栏评估，
// 落地为对生成仓库的静态扫描 + 运行时握手检查。返回人类可读报告。
// ---------------------------------------------------------------------------
function runAudit(outDir) {
  console.log("\n=== 质量门禁 (--audit) ===");
  console.log("（三栏评估：合规/安全/可用性，落地为可执行的静态扫描 + 运行时握手检查）\n");

  const items = [];
  const pass = (cat, name, detail) => items.push({ cat, name, level: "PASS", detail });
  const warn = (cat, name, detail) => items.push({ cat, name, level: "WARN", detail });
  const fail = (cat, name, detail) => items.push({ cat, name, level: "FAIL", detail });

  const paths = {
    index: path.join(outDir, "src/index.ts"),
    tools: path.join(outDir, "src/tools.ts"),
    api: path.join(outDir, "src/api-client.ts"),
    pkg: path.join(outDir, "package.json"),
    readme: path.join(outDir, "README.md"),
    envEx: path.join(outDir, ".env.example"),
    cfg: path.join(outDir, "mcp_config.example.json"),
  };
  const has = {};
  for (const k of Object.keys(paths)) has[k] = fs.existsSync(paths[k]);
  const read = (k) => (has[k] ? fs.readFileSync(paths[k], "utf8") : "");
  const src = read("index") + read("tools") + read("api") + read("cfg") + read("envEx");

  // ===== 合规 (Compliance) =====
  if (has.index) {
    const idx = read("index");
    if (/name:\s*"[^"]+"/.test(idx) && /version:\s*"[^"]+"/.test(idx))
      pass("合规", "Server 含 name + version", "index.ts 已声明 name/version");
    else fail("合规", "Server 含 name + version", "index.ts 缺少 name 或 version");
    if (/StdioServerTransport/.test(idx)) pass("合规", "stdio 传输已实现", "使用了 StdioServerTransport");
    else fail("合规", "stdio 传输已实现", "未检测到 StdioServerTransport");
  } else fail("合规", "源码文件存在", "src/index.ts 缺失");

  if (has.tools) {
    const t = read("tools");
    const re = /server\.tool\(\s*"([^"]+)"\s*,\s*"([\s\S]*?)"/g;
    let m, bad = [], count = 0;
    while ((m = re.exec(t))) {
      count++;
      if (!m[1] || (m[2] || "").trim().length === 0) bad.push(m[1] || "?");
    }
    if (count && !bad.length) pass("合规", "每个工具含 name + description", count + " 个工具均具备 name 与非空描述");
    else if (count) fail("合规", "每个工具含 name + description", "缺失/空描述工具：" + bad.join(", "));
    else fail("合规", "每个工具含 name + description", "未解析到任何 server.tool( 定义");
    if (/isError:\s*true/.test(t)) pass("合规", "错误响应遵循 MCP 格式", "handler 在 catch 中返回 isError:true");
    else warn("合规", "错误响应遵循 MCP 格式", "未检测到 isError:true（建议所有 handler 错误返回 isError:true）");
  } else fail("合规", "工具定义存在", "src/tools.ts 缺失");

  // ===== 安全 (Security) =====
  const secretPatterns = [
    /sk-[a-zA-Z0-9]{20,}/, /AKIA[0-9A-Z]{16}/, /Bearer\s+[A-Za-z0-9._-]{20,}/,
    /[aA]pi[_-]?[kK]ey\s*[:=]\s*["'][A-Za-z0-9]{16,}["']/,
    /[pP]assword\s*[:=]\s*["'][^"']{6,}["']/, /[tT]oken\s*[:=]\s*["'][A-Za-z0-9]{16,}["']/,
  ];
  if (secretPatterns.some((p) => p.test(src)))
    fail("安全", "无硬编码密钥/凭证", "检测到疑似硬编码密钥，请改为环境变量");
  else pass("安全", "无硬编码密钥/凭证", "源码与配置中未发现疑似硬编码密钥");

  if (has.tools) {
    const t = read("tools");
    const anyCount = (t.match(/z\.any\(\)/g) || []).length;
    if (anyCount === 0) pass("安全", "入参均有类型约束", "未使用 z.any()（body 除外）");
    else if (anyCount <= 1) warn("安全", "入参类型约束", "存在 " + anyCount + " 处 z.any()（多为 body 透传，可接受；可用 json-schema-to-zod 收紧）");
    else warn("安全", "入参类型约束", "存在 " + anyCount + " 处 z.any()，建议为关键入参补强类型");
  }

  if (has.tools) {
    const t = read("tools");
    const writeOps = (t.match(/"?(?:POST|PUT|PATCH|DELETE)"?/gi) || []).length;
    // 升级：写操作是否声明 MCP Tool Annotations（readOnlyHint/destructiveHint…），替代旧的描述文本检查。
    const annotated = (t.match(/readOnlyHint|destructiveHint|idempotentHint|openWorldHint/g) || []).length;
    if (writeOps === 0) pass("安全", "写操作注解声明", "无写操作（GET 只读），无需声明注解");
    else if (annotated >= 3) pass("安全", "写操作注解声明", "工具声明了完整的 Tool Annotations（readOnly/destructive/idempotent/openWorld），客户端可据此识别只读与破坏性（" + annotated + " 处）");
    else if (annotated >= 1) warn("安全", "写操作注解声明", "部分工具声明了 Tool Annotations（" + annotated + " 处），建议写操作统一声明 readOnlyHint/destructiveHint");
    else warn("安全", "写操作注解声明", "检测到 " + writeOps + " 个写操作（POST/PUT/DELETE），未声明任何 Tool Annotations，建议加 readOnlyHint/destructiveHint 让客户端识别只读/破坏性");
  }

  if (has.tools || has.api) {
    if (/e\.stack/.test(src)) fail("安全", "错误信息不泄露内部细节", "检测到向调用方返回 e.stack");
    else pass("安全", "错误信息不泄露内部细节", "未向调用方返回堆栈；仅返回状态码/消息");
  }
  warn("安全", "限流 / 调用审计（建议）", "生成器未内置限流与审计日志；公开/高并发部署前建议补充（见 README 扩展点）");

  // ===== 可用性 (Usability) =====
  if (has.readme) {
    const r = read("readme");
    if (/工具列表/.test(r) && /配置|鉴权|env/i.test(r) && /接入 MCP/.test(r))
      pass("可用", "README 含工具表 + 配置 + 接入", "README 齐全");
    else warn("可用", "README 含工具表 + 配置 + 接入", "README 缺少工具表/配置/接入之一");
  } else fail("可用", "README 含工具表 + 配置 + 接入", "README.md 缺失");

  if (has.api) {
    if (/JSON\.stringify/.test(read("api"))) pass("可用", "返回值格式稳定（JSON）", "callApi 对非字符串响应统一 JSON.stringify");
    else warn("可用", "返回值格式稳定（JSON）", "未检测到统一 JSON 序列化");
  }

  if (has.envEx) pass("可用", ".env.example 占位密钥", "已提供 .env.example 占位（勿提交真实密钥）");
  else warn("可用", ".env.example 占位密钥", "缺少 .env.example");

  if (has.readme && /安全|质量|副作用|isError/i.test(read("readme")))
    pass("可用", "文档含安全/质量说明", "README 已说明鉴权/错误/副作用等质量要点");
  else warn("可用", "文档含安全/质量说明", "README 未强调安全/质量要点（建议补充）");

  // ===== 运行时握手（仅当已编译） =====
  if (fs.existsSync(path.join(outDir, "build/index.js"))) {
    const h = handshakeProbe(outDir);
    if (h.ok) pass("合规", "运行时握手正常（tools/list）", "返回工具：" + (h.names.length ? h.names.join(", ") : "(空)"));
    else fail("合规", "运行时握手正常（tools/list）", "握手未返回工具；原始输出：\n" + h.raw.slice(0, 500));
  } else {
    warn("合规", "运行时握手（需先编译）", "build/index.js 不存在，跳过握手；加 --install 后可测");
  }

  // ===== 打印报告 =====
  const order = ["合规", "安全", "可用"];
  const icon = { PASS: "✅", WARN: "⚠️", FAIL: "❌" };
  let fails = 0, warns = 0;
  for (const cat of order) {
    const rows = items.filter((i) => i.cat === cat);
    if (!rows.length) continue;
    console.log("\n【" + cat + "】");
    for (const it of rows) {
      if (it.level === "FAIL") fails++;
      if (it.level === "WARN") warns++;
      console.log("  " + icon[it.level] + " " + it.name + (it.detail ? " — " + it.detail : ""));
    }
  }
  console.log("\n--- 审计汇总 ---");
  console.log("  ❌ FAIL: " + fails + "   ⚠️ WARN: " + warns + "   ✅ PASS: " + (items.length - fails - warns));
  if (fails) console.log("  ⛔ 存在 FAIL 项，建议修复后再发布/接入。");
  else if (warns) console.log("  🟡 无 FAIL，但有建议项（WARN），可按需优化。");
  else console.log("  🟢 全面通过，质量门禁绿灯。");
  return { fails, warns };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
(async () => {
  // 仅审计模式：对已有仓库做质量门禁，不重新生成
  if (args.audit && !args.spec && !args["spec-url"] && !args.manual) {
    const target = path.resolve(args.out);
    if (!fs.existsSync(target)) die("审计目标目录不存在: " + target);
    runAudit(target);
    return;
  }

  const loaded = await loadSpec();
  let data;
  if (loaded.manual) data = buildFromManual(loaded.manual);
  else data = buildFromSpec(loaded.spec);

  if (!data.tools.length) {
    console.log("⚠️ 未从规范中解析出任何工具（paths/operations 为空）。仍会生成仓库骨架。");
  }
  const outDir = args.mode === "skill" ? writeSkillRepo(data) : writeRepo(data);

  if (args.install || args["self-check"]) {
    if (args.mode === "skill") runSkillSelfCheck(outDir, data);
    else runInstallAndCheck(outDir);
  } else {
    console.log("\n（未传 --install，跳过安装/自检。需要时加 --install --self-check）");
  }

  if (args.audit) {
    if (args.mode === "skill") {
      // skill 模式无编译产物，仅做静态速查表/脚本可用性提示
      console.log("\n=== 质量门禁 (--audit, skill 模式) ===");
      const py = findPython();
      if (py) {
        const r = spawnSync(py, ["scripts/query_api.py", "--help"], { cwd: outDir, encoding: "utf8" });
        console.log(r.status === 0 ? "✅ 脚本 --help 正常，skill 包可用。" : "⚠️ 脚本 --help 异常。");
      } else console.log("⚠️ 未找到 python，跳过脚本自检。");
    } else {
      runAudit(outDir);
    }
  }
})().catch((e) => die(e.message || String(e)));
