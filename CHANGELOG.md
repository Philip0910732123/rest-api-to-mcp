# Changelog — rest-api-to-mcp

版本号遵循语义化版本（SemVer：`MAJOR.MINOR.PATCH`）。

**权威版本源 = GitHub tag（`vX.Y.Z`）**。发布到 WorkBuddy 技能中心时，
**填写与 GitHub tag 完全相同的版本号**，以保证两边一致、便于后续维护。

每次发版三步：
1. 在本文档加一条对应版本的变更记录；
2. `git tag vX.Y.Z` 并 `git push --tags`；
3. 在 WorkBuddy 技能中心后台以同一 `X.Y.Z` 发布 / 更新。

---

## [Unreleased]

## [1.1.1] — 2026-11-03

起因：把生成的 `quickgo-mcp` 打成 zip 分发给他人，在「另一台机器 + `mcp-config-wizard --from-zip`」的模拟环境里实测出的问题。都不是自测能撞到的，只有真的把包交出去才会暴露：

- **修复示例配置写入生成机绝对路径**：`mcp_config.example.json` 的 `args` 用 `{{OUT_ABS}}` 渲染，产出形如 `C:\Users\<user>\...\build\index.js`。打包分发后这个路径在别人机器上不存在（示例直接失效），同时泄露本机用户名与目录结构。改为占位 `/ABSOLUTE/PATH/TO/<pkg>/build/index.js`，并在 README 说明需替换。
- **无鉴权 API 不再输出误导性 `API_KEY`**：此前无论是否有鉴权，`.env.example` 与示例配置都会写 `API_KEY="YOUR_KEY_HERE"`，让 QuickGO 这类公开 API 的使用者以为要申请密钥。现在按 `auth.kind` 决定是否渲染该行。
- **新增审计项「示例配置不含本机绝对路径」**：`--audit` 静态扫描 `mcp_config.example.json`，命中盘符路径或 `/Users/`、`/home/` 即 FAIL。正反向均已验证（`https://` 中的 `s:/` 已排除，不误报）。
- **依赖基线抬到 `@modelcontextprotocol/sdk ^1.32.2` + `zod ^4.6.7`**：`zod < 4.6.6` 存在 GHSA-mrhx-c7xc-m3w5（校验超大受限集合时内存耗尽，high），且 zod 3 无补丁版本，只能升 4。已实测 `tsc` 通过、握手通过、真实调用通过、`z.enum` 合法值放行/非法值拦截正常；生成包的 `npm install` 从「1 high severity」变为「0 vulnerabilities」。
- **修复 `--install` 盲目复用旧 `node_modules`**：重新生成到已有目录时，若 `node_modules` 已存在就跳过安装，导致 `package.json` 写 `zod ^4.6.7`、实际仍跑 3.25.76，且从输出上看不出来。现在先比对声明的依赖范围与已安装版本（支持 `^`/`~`/精确版本），漂移则重装并打印具体差异。

## [1.1.0] — 2026-11-02

发布前回归压测（4 条主路径 × 真实 API）中挖出的问题，全部修掉并复验：

- **新增 `--help` / `-h`**：此前只敲 `--help` 会被当成"缺少输入参数"直接报错。现在输出完整用法（三路输入、两种产出、全部选项）。修 OpenAPI 与修 skill 的入口都是这条命令，属于公开发布的必备项。
- **修复握手自检把键名当工具名**：`handshakeProbe` 用正则 `/"name"\s*:\s*"([^"]+)"/g` 抓取，命中的始终是 JSON 的键 `"name"`，导致 `--self-check` 与 `--audit` 永远打印 `name, name, name...`（工具数也对不上）。改为逐行解析 JSON-RPC，取 `id=2` 的 `result.tools[].name`，现在能正确输出 `find_pets_by_status, get_pet_by_id, ...`。
- **修复工具名丢失驼峰分词**：`sanitizeToolName` 先 `toLowerCase()` 再替换非法字符，`operationId: findPetsByStatus` 被压成 `findpetsbystatus`。改为先按 camelCase/PascalCase 插下划线，输出 `find_pets_by_status`，可读性与可发现性明显改善。
- **修复生成的 skill 脚本在 Windows Git Bash 下 URL 拼错**：Git Bash 会把 `--endpoint /pet/1` 改写成 `C:/Program Files/Git/pet/1`，而 `urljoin` 把 `C:` 当成 scheme，最终请求到 `C:/Users/.../PortableGit/pet/1` 并报 `unknown url type: c`。新增 `demangle_windows_path()` 还原 Git 安装根目录前缀，带不带前导斜杠现在都能正确请求。
- **修复 `skill.manifest.json` 的 `exclude_paths` 排除了 `templates/`**：生成器运行时必须读取 `templates/`，若技能中心按此清单打包，发布出去的技能将无法生成任何东西。已移除该条目。
- **新增 `examples/`**：`petstore.json`（精简 OpenAPI 3.0，刻意覆盖 enum / integer / path 参数 / JSON body / DELETE）+ `README.md` 两分钟跑通指南。此前新用户 clone 下来没有任何可直接运行的样例。
- **`--audit` 有 FAIL 时退出码改为非零**：此前无论多少 FAIL 都返回 0，脚本/CI 无法据以拦截，质量门禁形同虚设。WARN 仍不影响退出码。
- **新增 GitHub Actions CI**（`.github/workflows/ci.yml`，3 个 job / 20 步）：`mcp-mode` 在 node 20+22 上跑 `--help` → 生成样例 → 握手 → 断言审计 0 FAIL、工具名分词、注解按 HTTP 方法声明、integer/enum 类型映射不退化；`skill-mode` 校验 Python 包可执行并断言 Git Bash 路径改写能被还原（离线断言，不依赖网络）；`release-check` 校验 SKILL.md/manifest 版本一致、`exclude_paths` 未误排 `templates/`。
- **移除硬编码的本机绝对路径**：生成器解析 YAML / 探测 Python 解释器时写死了 `C:/Users/<user>/.workbuddy/...` 的路径，公开仓库等于泄露本机用户名，换机也直接失效。改为 `$PYTHON` / `$PYTHON3` 优先 + 各平台常见命令（win32: `python`/`python3`/`py`）。

## [1.0.0] — 2026-11-02

- 首个公开发布版本。
- **双产出模式**：
  - `--mode mcp`（默认）：Node + TypeScript 的 stdio MCP server（依赖 `@modelcontextprotocol/sdk` + `zod`）。
  - `--mode skill`：WorkBuddy skill 包（Python 标准库零依赖，`SKILL.md` + `query_api.py` + `api_quickref.md`）。
- **两种输入**：OpenAPI 3.x（`--spec` / `--spec-url`，支持 JSON/YAML，YAML 用 pyyaml）或手动端点清单（`--manual`）。
- **工具设计已落实**：每个 REST 操作 → 一个 MCP 工具；`server.tool(name, desc, zodShape, annotations, handler)`；返回 `content` + `structuredContent.data`（解析后的 JSON 对象）；MCP Tool Annotations 按 HTTP 方法自动声明（`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`）；密钥只走 `env`。
- **质量门禁 `--audit`**：按「合规 / 安全 / 可用」三栏做可执行的静态扫描 + 运行时握手检查，给出 ✅/⚠️/❌ 报告与 FAIL/WARN/PASS 计数。
- **自检 `--install --self-check`**：MCP 模式 = `npm install` + `tsc` 编译 + 握手；skill 模式 = `python query_api.py --help` 冒烟。
- **类型忠实映射**：依据 OpenAPI `schema.type` 生成 `z.coerce.number()` / `z.coerce.boolean()` / `z.array(z.string())` / `z.enum`。
- **手动清单支持类型声明**：`--manual` 的 `queryParams`/`pathParams` 支持对象形式 `{name,type,enum,description,required}`，整数/布尔/枚举参数不再一律退化成 `z.string()`；字符串简写保持向后兼容。
- **发布基建（对标 mcp-config-wizard）**：`skill.manifest.json`、`CHANGELOG.md`、根目录 `README.md`、根目录 `.gitignore`、`scripts/publish.js`（GitHub 版：版本一致性校验 + 暂存打包 + changelog 提取，不依赖 skillhub CLI）；SKILL.md frontmatter 加 `version/slug/author/license`。
- **功能评估方法论**（借鉴 cn-mcp-builder）：10 个只读评估问题模板 `references/evaluation_questions.xml.example`，可借其 `evaluation.py` harness 跑。
- 对应 GitHub tag：`v1.0.0`。
- 对应技能中心版本：`1.0.0`（发布时填写）。
