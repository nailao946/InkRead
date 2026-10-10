#!/usr/bin/env node
/* gen-screens.mjs —— 用「真机截图」合成 1280×800 的商店宣传图
 *
 * 产出（plugin/store/screenshots/）：
 *   01-video-panel.png       视频面板（YouTube / 哔哩哔哩）
 *   02-article-lookup.png    网页文章 · 逐词上色 + 点词查释义
 *   03-article-ratings.png   网页文章 · 三套评级 + 阅读模式
 *
 * 用法：
 *   node plugin/tools/gen-screens.mjs
 *   node plugin/tools/gen-screens.mjs --src "C:/Users/admin/Pictures/read" --out "store/screenshots"
 *
 * 依赖：本机 Edge（headless 截图）。零 npm 依赖，PNG 以 base64 内联进 HTML，
 *       无跨域 / 路径问题，可重复生成。
 *
 * 设计说明：
 *   - 左栏 400px 放品牌 + 标题 + 三条编号卖点，与右侧截图上的 ①②③ 圆标一一对应。
 *   - 右侧截图用 object-fit:cover 满幅出血到上/右/下三边，最大化 UI 可读性；
 *     每个 shot 可单独指定 object-position，避免裁掉关键区域。
 *   - 圆标位置用「原图百分比」书写，脚本按 cover 变换换算成卡片像素，
 *     所以换截图或改裁切时不用重新调坐标。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const SRC = resolve(arg('src', 'C:/Users/admin/Pictures/read'));
const OUT = resolve(ROOT, arg('out', 'store/screenshots'));
const EDGE = process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const W = 1280, H = 800;
const LEFT = 400;                       // 左栏宽度
const BOX = { w: W - LEFT, h: H };      // 截图卡片区

/* ---------- 图片尺寸（读 PNG IHDR） ---------- */
function pngSize(file) {
  const b = readFileSync(file);
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504E47) throw new Error('不是 PNG: ' + file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

/* ---------- cover 变换：原图百分比 → 卡片像素 ---------- */
function coverFit(iw, ih, boxW, boxH, posX, posY) {
  const s = Math.max(boxW / iw, boxH / ih);
  const dw = iw * s, dh = ih * s;
  return {
    dw, dh,
    offX: (boxW - dw) * posX,
    offY: (boxH - dh) * posY,
    at(u, v) { return [this.offX + u * this.dw, this.offY + v * this.dh]; }
  };
}

/* ======================= 三张图的文案与卖点 ======================= */
const SHOTS = [
  {
    out: '01-video-panel.png',
    src: 'plugin1.png',
    pos: [1, 0.5],                       // 右对齐裁切：保住右侧面板
    title: '看视频之前，<br><em>先知道它难不难</em>',
    sub: '悬浮胶囊实时显示等级与可理解度；展开即见 i+1 建议、词频分布与高频生词榜。<br>支持 YouTube 与哔哩哔哩。',
    points: [
      ['等级一眼可见', 'L1–L4 阶梯 / CEFR / 蓝思，三套评级同时给出'],
      ['可理解度环', '31.7%，看懂多少一望即知'],
      ['高频生词榜', '按收益排序；太难会直接劝你别硬看']
    ],
    marks: [
      { n: 1, at: [0.7490, 0.538] },     // 三套评级 tab 行
      { n: 2, at: [0.7490, 0.711] },     // 可理解度环
      { n: 3, at: [0.7490, 0.852] }      // 高频生词榜
    ]
  },
  {
    out: '02-article-lookup.png',
    src: 'plugin2.png',
    pos: [0.5, 0.5],
    title: '读文章时，<br><em>逐词上色</em><br>点词即查',
    sub: '正文按你自己的词库逐词标注；点任意词弹出音标与中文释义，顺手标记掌握程度。',
    points: [
      ['三色标注', '已学 / 在学 / 生词，正文里一眼分清'],
      ['点词即查', '音标 + 中文释义，离线词典，无需联网'],
      ['悬浮胶囊', '不展开面板也知道这篇难不难']
    ],
    marks: [
      { n: 1, at: [0.4882, 0.203] },     // 正文上色区（"tell no lies." 行末空白）
      { n: 2, at: [0.2548, 0.670] },     // 释义卡片左上角
      { n: 3, at: [0.8325, 0.910] }      // 右下悬浮胶囊
    ]
  },
  {
    out: '03-article-ratings.png',
    src: 'plugin3png.png',
    pos: [0.5, 0.5],
    title: '一套内容，<br><em>三套评级随便切</em>',
    sub: 'L1–L4 阶梯、CEFR、蓝思随时切换；进入阅读模式后只留正文，可挑网页上色或底色标注。',
    points: [
      ['三套体系', 'L1–L4 阶梯 / CEFR / 蓝思，一键切换'],
      ['进入阅读模式', '去掉网页杂讯，只留干净正文'],
      ['高频生词榜', '按收益排序，优先背最值的那批']
    ],
    marks: [
      { n: 1, at: [0.6094, 0.334] },     // 三套评级 tab
      { n: 2, at: [0.6094, 0.475] },     // 进入阅读模式按钮
      { n: 3, at: [0.6094, 0.738] }      // 高频生词榜
    ]
  }
];

const FOOTER = [
  'chrome · edge · firefox',
  '不采集 · 不上传，数据只在本地',
  '可联动「墨读」桌面版词库'
];

/* ======================= HTML 模板 ======================= */
function html(shot, dataUri, iw, ih) {
  const [px, py] = shot.pos;
  const cf = coverFit(iw, ih, BOX.w, BOX.h, px, py);
  const marks = shot.marks.map(m => {
    const [x, y] = cf.at(m.at[0], m.at[1]);
    return `<span class="mk" style="left:${x.toFixed(1)}px;top:${y.toFixed(1)}px">${m.n}</span>`;
  }).join('\n      ');
  const points = shot.points.map((p, i) =>
    `<li><i>${i + 1}</i><div><b>${p[0]}</b><span>${p[1]}</span></div></li>`).join('\n        ');
  const footer = FOOTER.map(t => `<span>${t}</span>`).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: ${W}px; height: ${H}px; overflow: hidden; }
  body { font-family: "Microsoft YaHei", "PingFang SC", "Segoe UI", system-ui, sans-serif;
         -webkit-font-smoothing: antialiased; }
  .canvas { position: relative; width: ${W}px; height: ${H}px; overflow: hidden;
    background: radial-gradient(120% 150% at 10% 18%, rgba(120,84,22,.42), transparent 60%),
                linear-gradient(180deg, #12141a, #1b1f27); }
  .canvas::before { content: ''; position: absolute; inset: 0; pointer-events: none;
    background: linear-gradient(100deg, transparent 46%, rgba(255,226,150,.055) 50%, transparent 54%); }

  /* ---------- 左栏 ---------- */
  .col { position: absolute; left: 0; top: 0; width: ${LEFT}px; height: ${H}px;
         padding: 54px 38px 34px 58px; z-index: 2;
         display: flex; flex-direction: column; }
  .brand { flex: none; display: flex; align-items: center; gap: 13px; }
  .logo { flex: none; width: 54px; height: 54px; border-radius: 15px; display: grid; place-items: center;
    font-size: 26px; font-weight: 800; color: #1a1407;
    background: linear-gradient(140deg, #f7c948, #c2410c);
    box-shadow: 0 12px 28px rgba(0,0,0,.45), inset 0 2px 0 rgba(255,255,255,.25); }
  .logo span { display: block; transform: translateY(-6%); }
  .brand b { display: block; font-size: 19px; font-weight: 700; color: #fff; letter-spacing: .3px; }
  .brand small { display: block; margin-top: 3px; font-size: 12px; color: #8b93a3; letter-spacing: .2px; }

  .body { flex: 1; display: flex; flex-direction: column; justify-content: center; padding: 8px 0; }
  h1 { font-size: 36px; line-height: 1.32; font-weight: 800; color: #fff; letter-spacing: -.3px; }
  h1 em { font-style: normal; color: #f7c948; }
  .sub { margin: 17px 0 0; font-size: 13.2px; line-height: 1.78; color: #9aa1b0; }

  ul { list-style: none; margin: 32px 0 0; display: flex; flex-direction: column; gap: 18px; }
  li { display: flex; align-items: flex-start; gap: 12px; }
  li i { flex: none; width: 25px; height: 25px; border-radius: 50%; display: grid; place-items: center;
    font-style: normal; font-size: 13px; font-weight: 800; color: #1a1407;
    background: linear-gradient(140deg, #f7c948, #e0a52a);
    box-shadow: 0 4px 12px rgba(0,0,0,.38); }
  li b { display: block; font-size: 14.6px; font-weight: 700; color: #fff; }
  li span { display: block; margin-top: 4px; font-size: 12.2px; line-height: 1.55; color: #8b93a3; }

  .foot { flex: none; padding-top: 14px; border-top: 1px solid rgba(255,255,255,.08);
    display: flex; flex-direction: column; gap: 3px;
    font-size: 11.6px; color: #7d8494; letter-spacing: .1px; }
  .foot span:first-child { color: #9aa1b0; }

  /* ---------- 右侧截图卡片 ---------- */
  .card { position: absolute; left: ${LEFT}px; top: 0; width: ${BOX.w}px; height: ${BOX.h}px;
    border-radius: 22px 0 0 22px; overflow: hidden; z-index: 1;
    border: 1px solid rgba(255,255,255,.13); border-right: none;
    background: #0d0f14;
    box-shadow: -34px 0 70px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.06); }
  .card img { display: block; width: 100%; height: 100%;
    object-fit: cover; object-position: ${(px * 100).toFixed(0)}% ${(py * 100).toFixed(0)}%; }
  .mk { position: absolute; transform: translate(-50%, -50%);
    width: 29px; height: 29px; border-radius: 50%; display: grid; place-items: center;
    font-size: 14px; font-weight: 800; color: #1a1407;
    background: linear-gradient(140deg, #f7c948, #e6ab2b);
    box-shadow: 0 0 0 3.5px rgba(11,12,16,.94), 0 5px 16px rgba(0,0,0,.55); }
</style></head>
<body>
  <div class="canvas">
    <div class="card">
      <img src="${dataUri}" alt="">
      ${marks}
    </div>
    <div class="col">
      <div class="brand">
        <div class="logo"><span>读</span></div>
        <div><b>InkRead 墨读</b><small>视频与文章生词量</small></div>
      </div>
      <div class="body">
        <h1>${shot.title}</h1>
        <p class="sub">${shot.sub}</p>
        <ul>
        ${points}
        </ul>
      </div>
      <div class="foot">${footer}</div>
    </div>
  </div>
</body></html>`;
}

/* ======================= 主流程 ======================= */
if (!existsSync(EDGE)) {
  console.error('找不到 Edge：' + EDGE + '\n可用环境变量 EDGE 指定路径。');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
const TMP = resolve(tmpdir(), 'inkread-screens');
mkdirSync(TMP, { recursive: true });

console.log('源图目录：' + SRC);
console.log('输出目录：' + OUT + '\n');

let ok = 0; const bad = [];
for (const shot of SHOTS) {
  const srcFile = resolve(SRC, shot.src);
  if (!existsSync(srcFile)) { console.error('✗ 缺源图：' + srcFile); bad.push(shot.src); continue; }
  const { w, h } = pngSize(srcFile);
  const dataUri = 'data:image/png;base64,' + readFileSync(srcFile).toString('base64');
  const page = resolve(TMP, shot.out.replace(/\.png$/, '.html'));
  writeFileSync(page, html(shot, dataUri, w, h), 'utf8');

  const outFile = resolve(OUT, shot.out);
  const r = spawnSync(EDGE, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--force-device-scale-factor=1', '--default-background-color=00000000',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-sync', '--disable-background-networking',
    '--user-data-dir=' + resolve(TMP, 'profile'),
    `--window-size=${W},${H}`,
    '--virtual-time-budget=1500',
    '--screenshot=' + outFile,
    pathToFileURL(page).href
  ], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });

  if (!existsSync(outFile)) {
    console.error('✗ 截图失败：' + shot.out + '\n' + (r.stderr || ''));
    bad.push(shot.out); continue;
  }
  const g = pngSize(outFile);
  const kb = (statSync(outFile).size / 1024).toFixed(0);
  if (g.w === W && g.h === H) { console.log(`OK  ${shot.out}  ${g.w}×${g.h}  ${kb} KB`); ok++; }
  else { console.error(`✗ 尺寸不对：${shot.out} → ${g.w}×${g.h}（期望 ${W}×${H}）`); bad.push(shot.out); }
}

console.log(`\n完成 ${ok}/${SHOTS.length} → ${OUT}`);
if (bad.length) { console.error('失败：' + bad.join(', ')); process.exit(1); }
