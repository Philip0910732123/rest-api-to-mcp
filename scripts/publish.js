#!/usr/bin/env node
'use strict';
/**
 * publish.js — 维护者发版前置工具（不随技能分发：打包时自动排除自身）
 *
 * 作用：在「发布到 GitHub」之前做一致性校验 + 打出干净副本，避免把开发期文件
 * （.git / node_modules / 临时文件 / 本脚本自身）误提交，并防止版本号漂移。
 *
 * 与 mcp-config-wizard 版的区别：那边是推到 skillhub.cn（调 skills_store_cli.py），
 * 本技能发布目标是 **GitHub**，所以这里**不调用任何第三方 CLI**，只做：
 *   1) 版本一致性校验（SKILL.md frontmatter version == skill.manifest.json version）；
 *   2) git tag vX.Y.Z 检查（缺则告警，不阻断）；
 *   3) 从 CHANGELOG.md 自动抽取该版本的更新说明；
 *   4) 暂存（复制到临时目录，排除开发期文件）并打印「将发布哪些文件」；
 *   5) 打印推送到 GitHub 的下一步命令。
 *
 * 源目录一个字节都不改；不自动 commit / push（交给用户在自己仓库里执行）。
 *
 * 用法：
 *   node scripts/publish.js                 # 校验当前版本 + 暂存打包 + 打印发布清单
 *   node scripts/publish.js --dry-run       # 同上加 --keep 保留暂存目录便于核对
 *   node scripts/publish.js --changelog "手动写的更新说明"
 *   node scripts/publish.js --keep          # 保留临时暂存目录
 *   node scripts/publish.js --force         # 跳过版本一致性校验
 *
 * 参数：
 *   --version <x.y.z>   仅允许「与文件内版本一致」；不一致直接失败（防漂移）
 *   --changelog <文本>   不传则从 CHANGELOG.md 的 ## [<版本>] 段落自动提取
 *   --max-chars <n>     自动提取的 changelog 截断长度，默认 400
 *   --keep              保留暂存目录
 *   --force             跳过版本一致性校验
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const SKILL_DIR = path.resolve(__dirname, '..');

// 打包时排除：开发期文件与版本控制产物，以及本脚本自身
const EXCLUDE_DIRS = new Set(['.git', '.github', 'node_modules', '__pycache__', '.idea', '.vscode', 'out']);
const EXCLUDE_FILES = new Set(['.gitignore', '.gitattributes', '.DS_Store', 'Thumbs.db', 'publish.js']);
const EXCLUDE_SUFFIX = ['.log', '.tmp', '.bak', '.pyc'];

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`
};

function die(msg) {
  console.error(C.red('✗ ') + msg);
  process.exit(1);
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const key = k.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { a[key] = next; i++; } else { a[key] = true; }
  }
  return a;
}

function readSkillVersion() {
  const p = path.join(SKILL_DIR, 'SKILL.md');
  if (!fs.existsSync(p)) die('找不到 SKILL.md（发布根目录必须是技能目录）');
  const head = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').slice(0, 4000);
  const m = head.match(/^version:\s*["']?([0-9]+\.[0-9]+\.[0-9]+[^"'\s]*)["']?\s*$/m);
  return m ? m[1] : null;
}

function readManifestVersion() {
  const p = path.join(SKILL_DIR, 'skill.manifest.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')).version || null;
  } catch {
    die('skill.manifest.json 不是合法 JSON，先修好再发版');
  }
}

function extractChangelog(version, maxChars) {
  const p = path.join(SKILL_DIR, 'CHANGELOG.md');
  if (!fs.existsSync(p)) return null;
  const lines = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  const startIdx = lines.findIndex((l) => new RegExp(`^##\\s*\\[${version.replace(/\./g, '\\.')}\\]`).test(l));
  if (startIdx < 0) return null;
  const body = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    body.push(lines[i]);
  }

  const clean = (s) =>
    s
      .replace(/\*\*/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^#{1,6}\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();

  const blocks = [];
  let prevBlank = true;
  for (const raw of body) {
    const line = raw.trim();
    if (!line) { prevBlank = true; continue; }
    const isBullet = /^[-*]\s+/.test(line);
    if (isBullet) {
      blocks.push({ type: 'bullet', text: clean(line.replace(/^[-*]\s+/, '')) });
    } else if (!prevBlank && blocks.length && blocks[blocks.length - 1].type === 'bullet') {
      blocks[blocks.length - 1].text += clean(line);
    } else {
      blocks.push({ type: 'para', text: clean(line) });
    }
    prevBlank = false;
  }

  const trimEnd = (s) => s.replace(/[。；;：]\s*$/, '');
  const chunks = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const next = blocks[i + 1];
    const nextIsBullet = !!(next && next.type === 'bullet');
    if (b.type === 'para') chunks.push(trimEnd(b.text) + (nextIsBullet ? '：' : '。'));
    else chunks.push(trimEnd(b.text) + (nextIsBullet ? '；' : '。'));
  }

  let text = '';
  let truncated = false;
  for (const c of chunks) {
    if (text && text.length >= maxChars) { truncated = true; break; }
    text += c;
  }
  if (!text) return null;
  if (truncated) text = trimEnd(text) + '…';
  return text.trim();
}

function git(args) {
  const r = spawnSync('git', args, { cwd: SKILL_DIR, encoding: 'utf8' });
  return r.status === 0 ? (r.stdout || '').trim() : null;
}

function resolveStageRoot() {
  const candidates = [os.tmpdir(), path.join(os.homedir(), '.cache', 'ra2mcp-publish'), SKILL_DIR];
  for (const c of candidates) {
    try {
      fs.mkdirSync(c, { recursive: true });
      fs.accessSync(c, fs.constants.W_OK);
      return c;
    } catch {
      /* 换下一个 */
    }
  }
  die('找不到可写的临时目录，可用 TMPDIR 指定');
}

function stage(stageDir) {
  fs.mkdirSync(stageDir, { recursive: true });
  fs.cpSync(SKILL_DIR, stageDir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(SKILL_DIR, src);
      if (!rel) return true;
      const parts = rel.split(path.sep);
      if (parts.some((p) => EXCLUDE_DIRS.has(p))) return false;
      const base = parts[parts.length - 1];
      if (EXCLUDE_FILES.has(base)) return false;
      if (EXCLUDE_SUFFIX.some((suf) => base.endsWith(suf))) return false;
      return true;
    }
  });
  const list = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else list.push(path.relative(stageDir, full).split(path.sep).join('/'));
    }
  })(stageDir);
  return list.sort();
}

function main() {
  const a = parseArgs(process.argv.slice(2));

  const fileVer = readSkillVersion();
  const manVer = readManifestVersion();
  if (!fileVer) die('SKILL.md front matter 里没有 version:，先补上再发版');

  const version = a.version || fileVer;
  let failed = false;

  console.log(C.bold('\n=== 发版前校验 ==='));
  console.log(`  SKILL.md        ${fileVer}`);
  console.log(`  manifest.json   ${manVer || C.dim('(无)')}`);
  console.log(`  本次发布         ${version}`);

  if (!a.force) {
    if (manVer && manVer !== fileVer) {
      console.error(C.red('✗ ') + `版本不一致：SKILL.md=${fileVer}，skill.manifest.json=${manVer}`);
      failed = true;
    }
    if (a.version && a.version !== fileVer) {
      console.error(C.red('✗ ') + `--version ${a.version} 与文件内版本 ${fileVer} 不一致（防版本漂移；确需强制用 --force）`);
      failed = true;
    }
  }
  if (failed) process.exit(1);

  // git tag 是版本权威源：缺 tag 只告警，不阻断
  const localTag = git(['rev-parse', '--verify', '--quiet', `v${version}`]);
  const isRepo = git(['rev-parse', '--is-inside-work-tree']);
  if (!isRepo) {
    console.log(C.yellow('  ⚠ 当前技能目录还不是 git 仓库（发布前请 git init + 提交 + tag）'));
  } else if (!localTag) {
    console.log(C.yellow('  ⚠ 本地无 tag v' + version) + C.dim('（发完记得 git tag + push）'));
  } else {
    console.log(C.green('  ✓ tag v' + version + ' 已在本地'));
  }
  const dirty = git(['status', '--porcelain']);
  if (dirty) console.log(C.yellow('  ⚠ 工作区有未提交改动') + C.dim('（发布的是磁盘上的当前内容）'));

  // changelog
  let changelog = a.changelog;
  if (!changelog || changelog === 'auto') {
    const maxChars = Number(a['max-chars'] || 400);
    changelog = extractChangelog(version, maxChars);
    if (!changelog) {
      console.log(C.yellow(`  ⚠ CHANGELOG.md 里没找到 [${version}] 段落，GitHub Release 将不带更新说明`));
    } else {
      console.log(C.dim(`  changelog（自动提取 ${changelog.length} 字）：${changelog}`));
    }
  } else {
    console.log(C.dim(`  changelog（手填 ${changelog.length} 字）`));
  }

  // 暂存打包（源目录不改动；.gitignore / 本脚本 / node_modules 等在此被排除）
  const stageDir = path.join(resolveStageRoot(), `ra2mcp-publish-${version}-${Date.now()}`);
  const files = stage(stageDir);
  console.log(C.bold(`\n=== 将发布到 GitHub 的文件（${files.length}）===`));
  for (const f of files) console.log('  ' + f);

  console.log(C.bold('\n=== 下一步：推送到 GitHub ==='));
  console.log(C.dim('  （本工具不自动 commit/push，请在技能目录执行：）'));
  console.log('  cd ' + SKILL_DIR);
  if (!isRepo) console.log('  git init');
  console.log('  git add .');
  console.log('  git commit -m "release: v' + version + '"');
  console.log('  git tag v' + version);
  console.log('  git remote add origin <你的仓库地址>   # 首次');
  console.log('  git push -u origin main && git push --tags');

  if (!a.keep) {
    try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch {}
  } else {
    console.log(C.dim(`\n暂存目录保留：${stageDir}`));
  }

  console.log(C.green('\n✓ 校验通过，已列出发布清单与后续命令。'));
}

main();
