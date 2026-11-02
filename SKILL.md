---
name: rest-api-to-mcp
description: 把任意 REST API（OpenAPI 3.x 规范或手动端点清单）生成一个「可直接发布到 GitHub」的 MCP server 仓库（stdio 传输，Node + TypeScript），或一个 WorkBuddy skill 包（Python 零依赖，对标 ucsc-genome-api 那种「SKILL.md + 脚本」封装）。当用户想把某个 Web API / SaaS 接口封装成 AI 可调用的 MCP 工具或 skill、或要"从 OpenAPI 造一个 MCP/skill"时触发。
slug: rest-api-to-mcp
version: 1.0.0
author: hupan
license: MIT
---

# REST API → MCP / Skill 生成器

把 REST API 封装成两种产物之一，并产出**一个完整的、可发布的仓库/包**（不只是单个文件）：

- **MCP 模式（默认）**：Node + TypeScript 的 MCP server（stdio 传输），对标 `linxule/mineru-mcp` 的产出质量。
- **Skill 模式（`--mode skill`）**：WorkBuddy skill 包（Python 零依赖），对标你看到的 `ucsc-genome-api` 那种「`SKILL.md` + 一个查询脚本 + API 速查表」的轻封装。

两者用**同一套输入解析**（OpenAPI / 手动清单），只是渲染目标不同。

## 何时使用

- 用户说「把这个 API 包成 MCP」「从 OpenAPI 生成 MCP」「我想自己造一个 MCP server」「把 XX 接口封装成 MCP 工具」。
- 用户说「包成一个 skill」「做成 skill 封装」「不用 MCP、直接用脚本调这个 API」「做成零构建的封装」。
- 用户提供了 OpenAPI/Swagger 文档（JSON 或 YAML），或能列出端点清单。
- 与 `mcp-config-wizard` 互补：`mcp-config-wizard` 是**消费端**（配置别人做好的 MCP），本 skill 是**生产端**（自己造 MCP / skill）。

## 两种输入

1. **OpenAPI 规范**（推荐）：`--spec <文件>` 或 `--spec-url <URL>`。支持 `.json` 与 `.yaml/.yml`（YAML 自动用 python `pyyaml` 解析，缺则自动 `pip install pyyaml` 一次）。
2. **手动端点清单**：`--manual <文件>`。适合没有 OpenAPI、只有接口说明的情况。格式见下文「手动清单格式」。

## 运行生成器

```bash
# 从本地/远端 OpenAPI 生成 MCP 仓库，并自动安装+编译+握手自检
node scripts/generate_mcp_server.js \
  --spec openapi.json \
  --pkg my-api-mcp \
  --out ./out/my-api-mcp \
  --install --self-check

# 远端规范
node scripts/generate_mcp_server.js --spec-url https://x.com/openapi.json --pkg my-api-mcp --out ./out

# 手动清单 → MCP
node scripts/generate_mcp_server.js --manual endpoints.json --out ./out --install --self-check

# ★ Skill 模式：同样的输入，产出 WorkBuddy skill 包（Python 零依赖）
node scripts/generate_mcp_server.js \
  --mode skill \
  --spec openapi.json \
  --pkg my-api-mcp \
  --out ./out/my-api-mcp-skill \
  --self-check

# Skill 模式 + 手动清单
node scripts/generate_mcp_server.js --mode skill --manual endpoints.json --out ./out/my-api-skill --self-check
```

常用参数：
- `--mode <mcp|skill>`：**产出模式**（默认 `mcp`）。`skill` 模式产出可丢进 WorkBuddy skills 目录的 skill 包，无需 `npm install` / 编译。
- `--spec | --spec-url | --manual`：规范来源（三选一，必填）
- `--out <dir>`：输出目录（必填）。MCP 模式这里是仓库根；skill 模式这里是 skill 包根（建议命名为 `<slug>-skill`）。
- `--pkg <npm 包名>`：包名（默认由 title 推导）；skill 模式会据此生成 `<pkg>-skill` 的 skill 名。
- `--name` / `--author`：仓库展示名 / LICENSE 作者
- `--base-url`：覆盖 API base URL（默认取 `servers[0].url`）
- `--auth '<json>'`：手动指定鉴权，如 `'{"env":"API_KEY","header":"Authorization","valueTemplate":"Bearer ${API_KEY}"}'`（默认自动从 `components.securitySchemes` 推断；skill 模式同样适用，会写进脚本的环境变量读取逻辑）
- `--install --self-check`：生成后自检。MCP 模式 = `npm install` + `tsc` 编译 + 握手；skill 模式 = `python scripts/query_api.py --help` 冒烟。

## 鉴权（transport-aware，已踩坑固化）

生成器自动从 OpenAPI `securitySchemes` 推断鉴权，并写入**环境变量**（绝不写死密钥）：
- `apiKey in header` → `authHeaders()` 输出 `{"<headerName>": process.env.API_KEY}`
- `http bearer` → `Authorization: Bearer <API_KEY>`
- `apiKey in query` → 自动作为 query 参数追加（URL 形式）

⚠️ **MCP 鉴权字段铁律（来自 mcp-config-wizard 踩坑）**：本地 `stdio` server 用 `env` 注入密钥；远端 `streamableHttp` 服务才用 `headers`/`url`。本生成器产出的是**本地 stdio server**，所以一律走 `env`，并在 README / `mcp_config.example.json` 明确写出。

## 两种产出模式怎么选

两者都能把 REST API 封装成「AI 可调用的能力」，区别在架构与适用场景：

| 维度 | MCP 模式（默认） | Skill 模式（`--mode skill`） |
| --- | --- | --- |
| 产物 | 独立长驻进程（stdio），AI 连上去调 `tools/list` | skill 目录，AI 读 `SKILL.md` 后自己 `Bash` 跑脚本 |
| 工具发现 | 正式工具注册表，zod 强类型、自动枚举 | 无注册表，AI 按 `references/api_quickref.md` 选端点 |
| 构建 | 必须 `npm install` + `tsc` 编译 | **零构建**，Python 标准库脚本直接跑（无需 `requests`） |
| 鉴权 | env 注入到 MCP 进程 | env 在脚本内部读取 |
| 跨平台 | 需 Node + npm + 构建 | Python 几乎处处有 |
| 复用/分发 | 发 npm/GitHub，任意 MCP 客户端可用 | 丢进 skills 目录即可，任意会加载 skill 的客户端可用 |
| 适合 | 操作多、要正式工具面、跨客户端共享 | 单用途取数、不想构建、需要 AI 判断（prompt→端点） |

**经验法则**：要「正式工具 + 跨产品共享 + 强类型入参」选 MCP；要「立刻能用、零构建、轻封装、AI 自带判断」选 skill。两者输入完全互通，随时可重跑切换。

## 产出仓库结构（MCP 模式）

```
my-api-mcp/
├── package.json          # type:module, bin 指向 build/index.js, 依赖 sdk + zod
├── tsconfig.json
├── src/
│   ├── index.ts          # McpServer + StdioServerTransport 启动
│   ├── api-client.ts      # baseUrl / 鉴权头 / buildUrl / callApi（fetch 封装）
│   └── tools.ts           # 每个 REST 操作 → 一个 MCP 工具（自动生成）
├── README.md             # 安装/配置/接入/工具列表表
├── LICENSE               # MIT
├── .gitignore            # 忽略 node_modules / build / .env
├── .env.example          # API_BASE_URL + 密钥占位
├── Dockerfile            # node:20-alpine
└── mcp_config.example.json  # 直接并入 mcp.json 的片段
```

每个工具 = `server.tool(name, description, zodShape, annotations, handler)`：handler 负责把 MCP 入参翻译成 HTTP 请求，返回 `content`（文本）+ `structuredContent.data`（解析后的 JSON 对象）；`annotations` 按 HTTP 方法自动声明只读/破坏性/幂等/外部交互。`path` 参数用 `{id}` 占位、`query` 参数自动拼 `?key=val`、`body` 参数序列化为 JSON。

⚠️ **工具命名**：生成的工具名直接取 `operationId`（已 sanitize 成小写蛇形，**不带 `<pkg>_` 前缀**，因为同一 server 只封装一个 API，命名空间交给客户端）。例如 `search_terms`、`get_terms`。在 WorkBuddy 里实际调用名会是 `mcp__<server名>__search_terms`（server 名即 `mcp.json` 里的 key）。参数类型按 OpenAPI `schema.type` 保真映射：`integer/number → z.coerce.number()`、`boolean → z.coerce.boolean()`、`array → z.array(z.string())`、其余 `z.string()`；枚举保持 `z.enum`。

## 产出结构（Skill 模式，`--mode skill`）

```
my-api-mcp-skill/
├── SKILL.md                 # name/description 头 + 执行协议 + 输出契约 + CLI 示例 + 护栏
├── scripts/
│   └── query_api.py         # 通用化版 query_ucsc.py：仅用标准库，支持 --endpoint/--prompt/--params/--body/--header/--out
├── references/
│   └── api_quickref.md      # 由 OpenAPI paths / 手动清单自动生成的端点速查表
├── LICENSE                  # MIT
└── .gitignore               # 忽略 __pycache__ / .env 等
```

脚本约定与 `ucsc-genome-api` 一致：返回归一化 JSON 信封（`status`/`source`/`request`/`count`/`data`/`errors`/`next_page`）。`--endpoint` 直连优先；`--prompt` 仅做关键词→端点的尽力匹配（命中不了会列出可用端点并提示用 `--endpoint`）。密钥走 `API_KEY_ENV` 环境变量，绝不写死。

**接入 WorkBuddy**：把整个 `my-api-mcp-skill/` 目录丢进 `~/.workbuddy/skills/` 即可被加载（无需构建、无需重启客户端，skill 列表自动刷新）。

## 手动清单格式（--manual）

```json
{
  "name": "ACME API", "pkg": "acme-mcp", "baseUrl": "https://acme.test/api",
  "auth": { "env": "ACME_TOKEN", "header": "Authorization", "valueTemplate": "Bearer ${ACME_TOKEN}" },
  "tools": [
    { "name": "search", "method": "GET", "path": "/search", "queryParams": ["q","page"], "description": "搜索" },
    { "name": "get_user", "method": "GET", "path": "/users/{id}", "pathParams": ["id"], "description": "获取用户" },
    { "name": "create_user", "method": "POST", "path": "/users", "body": true, "description": "创建用户" }
  ]
}
```

**参数类型（手动模式也要保真）**：`queryParams` / `pathParams` 的每个元素可以是**字符串**（仅给参数名，默认 `string` 类型）或**对象**显式声明类型——对象形式会让生成器沿用 OpenAPI 同样的「类型忠实 zod 映射」（`integer/number → z.coerce.number()`、`boolean → z.coerce.boolean()`、`array → z.array(z.string())`、`enum` 保持 `z.enum`）。批量声明比逐个字符串更准：

```json
"tools": [
  {
    "name": "search", "method": "GET", "path": "/search",
    "queryParams": [
      { "name": "q", "required": true, "description": "关键词" },
      { "name": "page", "type": "integer", "description": "页码，从 1 开始" },
      { "name": "limit", "type": "integer", "description": "每页条数" }
    ],
    "description": "搜索"
  },
  {
    "name": "get_user", "method": "GET", "path": "/users/{id}",
    "pathParams": [{ "name": "id", "required": true, "description": "用户 ID" }],
    "description": "获取用户"
  }
]
```

> 提示：手动模式默认所有参数 `string`。凡是整数/布尔/枚举参数，务必用上面的**对象形式**声明 `type`，否则生成的 zod 会把数字参数也当字符串（能用，但类型不精确、CLI/agent 传数字时要先转字符串）。`

## 验证

- **MCP 模式**：生成器带 `--self-check` 会自动：起 `node build/index.js` → 发 `initialize` → `tools/list`，打印工具名。握手失败会明确报错。用户侧最终确认：把 `mcp_config.example.json` 并入客户端 `mcp.json` → **完全退出重启客户端** → 连接器页「信任」→ 在对话里调用一个工具看真实返回。
- **Skill 模式**：生成器带 `--self-check` 会自动跑 `python scripts/query_api.py --help` 做冒烟（脚本仅用标准库，无需 `requests`）。用户侧最终确认：把 skill 目录丢进 `~/.workbuddy/skills/` → 在对话里让 AI 调用 `python scripts/query_api.py --endpoint <端点>` 看真实返回。

## 质量门禁（`--audit`）

> 质量门禁按 **合规 / 安全 / 可用** 三栏评估，落地为**可执行**检查——不是文档里写几条原则就完事，而是对生成仓库做静态扫描 + 运行时握手，给出 ✅/⚠️/❌ 报告。

**两种用法**：

```bash
# 1) 生成的同时做审计（推荐）：先 --install 编译出 build/index.js，审计会额外跑运行时握手
node scripts/generate_mcp_server.js --spec openapi.json --pkg x-mcp --out ./out/x-mcp --install --self-check --audit

# 2) 仅审计已有仓库（不重新生成）：对生成的产物做质量门禁
node scripts/generate_mcp_server.js --audit ./out/x-mcp
```

**三栏检查项**（生成器自动逐项判定）：

| 栏 | 检查项 | 级别 |
| --- | --- | --- |
| 合规 | Server 含 name + version；stdio 传输已实现；每个工具含 name + 非空描述；错误返回 `isError:true`；运行时 `tools/list` 握手返回工具 | ✅/⚠️/❌ |
| 安全 | 无硬编码密钥/凭证；入参均有类型约束（z.any 数量预警）；写操作声明 `readOnlyHint`/`destructiveHint` 注解；错误不泄露内部堆栈；限流/审计（建议项） | ✅/⚠️/❌ |
| 可用 | README 含工具表 + 配置 + 接入说明；返回值统一 JSON；`.env.example` 占位密钥；文档含安全/质量说明 | ✅/⚠️/❌ |

报告末尾给出 `FAIL / WARN / PASS` 计数：有 FAIL 建议先修再发布/接入；仅 WARN 可按需优化；全绿即质量门禁通过。

> 注：评估维度必须落到**能跑的检查**上——只在文档里写「做合规检查 / 做安全评估」而不提供脚本，对使用者没有价值。本 skill 的三栏检查由 `--audit` 真实执行，所以不需要额外的向导式交互。

## 功能评估（进阶，借鉴 cn-mcp-builder）

> `--audit` 查的是「代码结构对不对、握手通不通」（静态 + 运行时）。但它**不查「LLM 到底能不能用这些工具答对真实复杂问题」**——这是更高一层的功能性验证。这部分借鉴自 skillhub 的 **cn-mcp-builder** 的评估方法论：本 skill 不照搬它的 Python 脚本（要 `anthropic` + `mcp` 依赖 + API key，跨语言太重），而是复用其方法论 + 模板，并用它现成的 `evaluation.py` harness 来跑。

**方法论（10 个只读评估问题）**：为生成的 MCP 造一份评估集，要求每个问题：
- **独立 / 只读 / 非破坏 / 幂等**：只用 GET 类工具就能答，绝不要求写操作；
- **复杂多跳**：需要多次工具调用、跨数据关联、翻页探索，不能靠关键词直搜；
- **稳定**：答案不随时间变化（用已闭合的历史数据，不要问「当前有多少条」）；
- **可验证**：答案单一、可用字符串直接比对（用户名 / 名称 / 数字 / 布尔 / 日期）；
- **真实**：贴近人类会用这个 API 做的检索任务。

**评估集模板**：`references/evaluation_questions.xml.example`（已随本 skill 提供，按上面规则填 10 个 `<qa_pair>`）。

**如何跑（借 cn-mcp-builder 的 harness）**：需 Python + 依赖 + Anthropic key。harness 会自动拉起你的 stdio server 并让 Claude 用工具答题，产出 accuracy 报告。

```bash
# 1) 准备环境（cn-mcp-builder 目录）
CN=~/.workbuddy/skills/cn-mcp-builder__skillhub
pip install -r "$CN/scripts/requirements.txt"   # anthropic, mcp
export ANTHROPIC_API_KEY=sk-xxx

# 2) 跑评估：用我们的产物（node build/index.js）作为 stdio server
python "$CN/scripts/evaluation.py" \
  -t stdio -c node -a /绝对路径/产物/build/index.js \
  -e API_BASE_URL="https://api.x.com" \
  -e <AUTH_ENV>=<你的密钥> \
  evaluation.xml
```

报告会给出：准确率（正确/总数）、平均任务耗时、平均每个任务工具调用数、每题的 agent 反馈（工具名/参数/描述是否清晰、返回是否过大/过小）。**重点看 agent 的 `<feedback>`**——那是最真实、最可操作的「工具好不好用」信号，据此回到 `src/tools.ts` 调描述、补 `limit`、收敛返回字段。

> 注：cn-mcp-builder 自带 `scripts/evaluation.py` + `example_evaluation.xml`，其示例是 Python server（`-c python -a server.py`）；我们产物是 Node，改用 `-c node -a build/index.js` 即可，其余参数完全一致。

## Tool 设计规范

生成器已自动落实以下规范的大部分；若你手工微调 `src/tools.ts`，请遵循同一套原则：

- **查询类工具**（GET，只读）：描述写清「查什么、返回什么、何时用」。生成器已把 OpenAPI 的 `summary/description` 写入工具描述，并自动声明 `readOnlyHint:true`。
- **操作类工具**（POST/PUT/PATCH/DELETE，写操作）：生成器**自动声明 MCP Tool Annotations**（协议级，比描述文本更规范）：`readOnlyHint:false`、`destructiveHint`（仅 DELETE 为 `true`）、`idempotentHint`（POST 为 `false`、其余为 `true`）、`openWorldHint:true`。客户端（WorkBuddy/Claude）据此直接识别「只读/破坏性」并给出护栏提示，无需在描述里塞文本。
- **批处理类工具**（批量增删改）：建议加 `dry_run` 参数（默认 `true` 仅预览），确认无误再执行——生成器暂未自动加，需手工在 `src/tools.ts` 补。
- **通用铁律**：每个入参有类型约束与范围说明（已按 OpenAPI `schema.type` 保真）；返回统一 JSON **且附带 `structuredContent`**（下游程序化解析可直接取 `data` 字段）；错误返回 MCP `isError:true` 信封并附排查建议；密钥只走 `env`。

## 发布到 GitHub（用户提供仓库后）

1. 生成器产出的是**完整本地仓库**（含 LICENSE / .gitignore / README）。
2. 用户给出自己的 GitHub 仓库与 token/API 后：在产出目录 `git init`（若尚未）→ `git add .` → `git commit` → `git remote add origin <用户仓库>` → `push`。
3. 发布到 npm（可选）：`npm publish`（需 `npm login`）。
4. 提示用户：`.env` 已被忽略，密钥**不要提交**；`mcp_config.example.json` 里只放占位符。

## 已知边界 / 扩展点

- **长任务 / 异步 API**（如 MinerU 的「提交→轮询→下载」）：当前生成器对每个操作做**同步直接调用**。若目标 API 是异步模式，MCP 模式需在 `src/tools.ts` 对应 handler 里加轮询逻辑（参考 `linxule/mineru-mcp` 的 `mineru_batch_status` + `mineru_download_results`）；skill 模式则在 `scripts/query_api.py` 对应分支里加轮询。后续可在 OpenAPI 里加 `x-mcp-async` 扩展来支持自动生成轮询。
- **分页 / 重试 / 超时**：在 `src/api-client.ts` 的 `callApi` 里统一扩展。
- **复杂请求体**：当前 `body` 用 `z.any()`（AI 自行构造 JSON），未做 JSON-Schema→zod 的深度转换。如需严格 schema，可后续接入 `json-schema-to-zod`。
- **结构化输出与注解（已默认开启）**：每个工具已自动返回 `structuredContent.data`（解析后的 JSON 对象，便于下游程序化消费），并声明 MCP Tool Annotations（`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`，依 HTTP 方法自动推导），无需手工处理。
- **环境变量鉴权名**若与现有冲突，用 `--auth` 显式指定。

## 与 mcp-config-wizard 的协同

本 skill 是 MCP 的**生产端**，mcp-config-wizard 是**消费端**（配置接入）。按 mcp-config-wizard 的口径分两类接法：

- **第二类 · 本地 Node 源码包（默认，推荐你这种本地造的）**：生成器产出的 `mcp_config.example.json` **已经是可直接并入 `mcp.json` 的本地 stdio 形态**——`command: "node"` + `args: ["<仓库绝对路径>/build/index.js"]` + `env` 注入密钥。你手头的 `pdb` / `imgt` / `fda` / `who` 全是这种。注意：必须先 `npm install` + `npm run build`（加 `--install --self-check` 会自动做）编译出 `build/index.js`，否则 `node build/index.js` 会报文件不存在。
- **第一类 · 纯 JSON / npx（需先 `npm publish`）**：若已把包发布到 npm，可改用纯 JSON 形态：`command: "npx"`、`args: ["-y", "<pkg>"]`，免本地构建。没发布前**不要**用 npx 形式（包不存在会启动失败）。

两者构成「生产 MCP + 消费 MCP」闭环。Skill 模式产物不需要走 mcp-config-wizard（那是 MCP 消费端），直接把 `<slug>-skill/` 丢进 `~/.workbuddy/skills/` 即可被加载。
