# rest-api-to-mcp

WorkBuddy 技能（skill）：把任意 REST API 封装成 **AI 可调用的能力**——生成一个「可直接发布到 GitHub」的产物，有两种形态可选：

- **MCP server**（默认，`--mode mcp`）：Node + TypeScript 的 stdio MCP server，任意支持 MCP 的客户端（WorkBuddy / Claude Desktop / Cursor …）都能加载，工具面正式、入参强类型。
- **WorkBuddy skill 包**（`--mode skill`）：Python 标准库零依赖的 skill 包（对标 `ucsc-genome-api` 那种「`SKILL.md` + 脚本」封装），无需 `npm install`、无需编译，丢进 skills 目录即用。

两种产物用**同一套输入解析**（OpenAPI 3.x 规范，或手动端点清单），只是渲染目标不同。

## 安装到 WorkBuddy

```bash
git clone <this-repo> ~/.workbuddy/skills/rest-api-to-mcp
```

WorkBuddy 启动时会自动加载。技能本体只需要 Node（≥18）跑生成器；生成的 MCP server 产物需要 `@modelcontextprotocol/sdk` + `zod`（生成器自动 `npm install`）。

## 快速开始

```bash
# 从 OpenAPI 生成 MCP 仓库，并自动安装 + 编译 + 握手自检 + 质量门禁审计
node scripts/generate_mcp_server.js \
  --spec openapi.json \
  --pkg my-api-mcp \
  --out ./out/my-api-mcp \
  --install --self-check --audit

# 没有 OpenAPI？用手动端点清单（整数/布尔/枚举参数用对象形式声明类型）
node scripts/generate_mcp_server.js --manual endpoints.json --out ./out --install --self-check

# 想要零构建的 skill 包（Python 脚本）
node scripts/generate_mcp_server.js --mode skill --spec openapi.json --out ./out/my-api-skill --self-check
```

常用参数：

| 参数 | 说明 |
|---|---|
| `--mode <mcp\|skill>` | 产出形态（默认 `mcp`） |
| `--spec \| --spec-url \| --manual` | 规范来源（三选一，必填） |
| `--out <dir>` | 输出目录（必填） |
| `--pkg <名>` | npm 包名 / skill 名 |
| `--base-url` | 覆盖 API base URL |
| `--auth '<json>'` | 手动指定鉴权（env 注入，绝不写死密钥） |
| `--install --self-check` | 生成后安装依赖 + 编译 + 握手 |
| `--audit` | 质量门禁（合规 / 安全 / 可用 三栏可执行检查） |

## 两种产物的取舍

| 维度 | MCP 模式（默认） | Skill 模式（`--mode skill`） |
|---|---|---|
| 产物 | 独立长驻进程（stdio） | skill 目录，AI 读 `SKILL.md` 后跑脚本 |
| 工具发现 | 正式工具注册表，zod 强类型 | 无注册表，AI 按速查表选端点 |
| 构建 | 必须 `npm install` + `tsc` | **零构建**，Python 标准库直接跑 |
| 适合 | 操作多、要正式工具面、跨客户端共享 | 单用途取数、不想构建、要 AI 自带判断 |

## 生成的 MCP server 长什么样

```
my-api-mcp/
├── package.json          # type:module, bin → build/index.js
├── src/
│   ├── index.ts          # McpServer + StdioServerTransport
│   ├── api-client.ts      # baseUrl / 鉴权头 / buildUrl / callApi(fetch)
│   └── tools.ts          # 每个 REST 操作 → 一个 MCP 工具（自动生成）
├── README.md             # 工具表 + 配置 + 接入说明
├── LICENSE               # MIT
├── .gitignore
├── .env.example          # API_BASE_URL + 密钥占位
├── Dockerfile            # node:20-alpine
└── mcp_config.example.json  # 直接并入 mcp.json 的片段
```

每个工具：`server.tool(name, description, zodShape, annotations, handler)`；handler 把 MCP 入参翻译成 HTTP 请求，返回 `content`（文本）+ `structuredContent.data`（解析后的 JSON 对象）；`annotations` 按 HTTP 方法自动声明只读 / 破坏性 / 幂等 / 外部交互。**密钥只走环境变量**。

## 质量门禁（`--audit`）

不是文档里写几条原则，而是对生成仓库做**静态扫描 + 运行时握手**，按「合规 / 安全 / 可用」三栏给出 ✅/⚠️/❌ 报告与 `FAIL/WARN/PASS` 计数：无硬编码密钥、写操作声明 Tool Annotations、入参有类型约束、README 含工具表与接入说明、握手返回工具等。有 FAIL 建议先修再发布。

## 完整文档

详见 [SKILL.md](SKILL.md)（权威使用说明、两种输入格式、手动清单类型声明、功能评估方法论、已知边界）。

## 版本管理（GitHub ↔ 技能中心 对齐）

- 版本号用 SemVer（`MAJOR.MINOR.PATCH`）。
- **GitHub tag（`vX.Y.Z`）是权威版本源**；本仓库的 [CHANGELOG.md](CHANGELOG.md) 记录每次变更。
- 发布到 WorkBuddy 技能中心时，**填写与 GitHub tag 相同的版本号**，保证两边一致。
- 发版流程：① 在 `CHANGELOG.md` 加一条 → ② `git tag vX.Y.Z` + `git push --tags` → ③ 在技能中心后台以同一 `X.Y.Z` 发布 / 更新。

## License

MIT
