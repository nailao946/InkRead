#!/usr/bin/env node
/* check-syntax.mjs —— 语法检查所有源码
 *
 * 为什么需要：本项目没有构建步骤，扩展源码全是原生 ESM / 经典脚本，改完直接加载。
 * 而 src/**\/*.js 用的是 .js 扩展名，`node --check` 会按 CommonJS 解析并误报 import 语法错。
 * 做法：复制到临时目录改名为 .mjs 再交给 `node --check`（只编译不求值，无副作用）。
 *
 *   node plugin/tools/check-syntax.mjs
 */
import { readFileSync, writeFileSync, readdirSync, statSync, rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative, posix, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const TMP = join(tmpdir(), 'inkread-video-syntax');

const walk = (dir, ext, out) => {
  out = out || [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (p.endsWith(ext)) out.push(p);
  }
  return out;
};
const checkOne = (file, label) => {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status === 0) { console.log('  ok    ' + label); return 1; }
  console.log('  FAIL  ' + label);
  String(r.stderr || '').split('\n').slice(0, 6).forEach(s => s && console.log('        ' + s));
  return 0;
};

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

let ok = 0, bad = 0;

/* ① src 下的 .js —— 需改名 .mjs 才能按 ESM 解析 */
for (const f of walk(SRC, '.js').sort()) {
  const rel = posix.normalize(relative(SRC, f));
  const dst = join(TMP, rel.replace(/[\\/]/g, '__') + '.mjs');
  writeFileSync(dst, readFileSync(f));
  (checkOne(dst, 'src/' + rel) ? ok++ : bad++);
}

/* ② tests / tools 下的 .mjs —— 直接 check */
for (const dir of ['tests', 'tools']) {
  for (const f of walk(join(ROOT, dir), '.mjs').sort()) {
    (checkOne(f, posix.normalize(relative(ROOT, f))) ? ok++ : bad++);
  }
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\n语法检查：ok=${ok}  fail=${bad}`);
process.exit(bad ? 1 : 0);
