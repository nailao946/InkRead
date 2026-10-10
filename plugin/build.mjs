#!/usr/bin/env node
/* build.mjs —— 打包扩展：dist/<chrome|edge|firefox>/ + 对应 zip
 *
 * 零依赖：ZIP 读写见 tools/zip.mjs（那套也在 test-integration 里被单测）。
 *   node plugin/build.mjs            # 全量打包
 *   node plugin/build.mjs chrome     # 只打 chrome
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeZip, walkFiles } from './tools/zip.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const DIST = resolve(ROOT, 'dist');

/* 打进包里的运行时文件/目录（其余都属开发件，不进包） */
const INCLUDE = ['src', 'icons', 'data'];

const TARGETS = {
  chrome: { manifest: 'manifest.json', label: 'Chrome / Edge (MV3)' },
  edge: { manifest: 'manifest.json', label: 'Edge (同 Chrome 包)' },
  firefox: { manifest: 'manifest.firefox.json', label: 'Firefox (MV3 event page)' }
};

function build(target) {
  const cfg = TARGETS[target];
  const man = JSON.parse(readFileSync(resolve(ROOT, cfg.manifest), 'utf8'));
  const outDir = resolve(DIST, target);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  /* manifest 统一叫 manifest.json（Firefox 用它的变体） */
  const manBuf = readFileSync(resolve(ROOT, cfg.manifest));
  writeFileSync(resolve(outDir, 'manifest.json'), manBuf);

  const entries = [{ name: 'manifest.json', data: manBuf }];
  for (const item of INCLUDE) {
    const abs = resolve(ROOT, item);
    for (const f of walkFiles(abs, ROOT)) {
      cpSync(f.abs, resolve(outDir, f.rel));
      entries.push({ name: f.rel, data: readFileSync(f.abs) });
    }
  }

  /* 出包前自检：条目名必须是正斜杠，且 manifest 必须在第一个（浏览器先读它） */
  const bad = entries.find(e => e.name.includes('\\'));
  if (bad) throw new Error(`ZIP 条目名含反斜杠，浏览器会找不到文件：${bad.name}`);
  if (entries[0].name !== 'manifest.json') throw new Error('manifest.json 必须是包内第一个条目');
  for (const need of ['src/background/sw.js', 'src/content/content.js']) {
    if (!entries.some(e => e.name === need)) throw new Error('缺少必需文件：' + need);
  }

  const zipPath = resolve(DIST, `inkread-video-${target}-v${man.version}.zip`);
  const buf = makeZip(entries);
  writeFileSync(zipPath, buf);

  console.log(`\n▼ ${target}  (${cfg.label})`);
  console.log(`   目录：${relative(process.cwd(), outDir) || outDir}`);
  console.log(`   压缩包：${relative(process.cwd(), zipPath)}  (${(buf.length / 1024).toFixed(1)} KB, ${entries.length} 个文件)`);
  return { target, files: entries.length, bytes: buf.length };
}

const want = process.argv.slice(2).filter(a => !a.startsWith('-'));
const targets = want.length ? want : Object.keys(TARGETS);
const bad = targets.filter(t => !TARGETS[t]);
if (bad.length) { console.error('未知目标：' + bad.join(', ')); process.exit(1); }

mkdirSync(DIST, { recursive: true });
targets.map(build);

console.log('\n安装方式：');
console.log('  Chrome / Edge：chrome://extensions 或 edge://extensions → 开发者模式 → 「加载已解压的扩展程序」');
console.log('                 选 plugin/dist/chrome（开发期也可直接加载 plugin/ 目录本身）');
console.log('  Firefox：about:debugging#/runtime/this-firefox → 「临时载入附加组件」→ 选 plugin/dist/firefox/manifest.json');
console.log('            长期安装需签名：npx web-ext build --source-dir plugin/dist/firefox');
