# InkRead Video — 视频生词量与等级（浏览器扩展）

给**哔哩哔哩 / YouTube** 的视频算一笔账：**这个词视频对我（你的墨读词库）来说，有多难？值不值得看？**

打开视频就自动分析，右下角出现等级胶囊，点开是完整面板：

- **可理解度**环形图 + **L1–L4 等级**（与墨读阅读端的书籍难度**完全同口径**）
- **i+1 推荐**：95–98% 为「理想区」，直接告诉你「符合 i+1」还是「超出当前水平」
- **生词量**：总词次 / 独立词 / 生词词次 / 生词密度（每百词）
- **客观难度**：脱离你个人词库、只看用词本身的 L1–L5 与词频分层（核心 1000 / 常用 2500 / 进阶 / 高阶 / 生僻）
- **高频生词榜**：按出现次数排序，先攻这些收益最大

支持 **Chrome / Edge / Firefox**，同一套代码（Manifest V3）。

---

## 1. 安装

### 先打包（`dist/` 是构建产物，未入库）

```bash
node plugin/build.mjs              # 全量：dist/chrome、dist/edge、dist/firefox + 三个 zip
node plugin/build.mjs chrome       # 只打 Chrome/Edge
```

### Chrome / Edge

1. 打开 `chrome://extensions` 或 `edge://extensions`
2. 打开右上角 **开发者模式**
3. **加载已解压的扩展程序** → 选 `plugin/dist/chrome`
   （开发期也可以直接选 `plugin/` 目录本身，改完点「重新加载」即可）

### Firefox

1. 打开 `about:debugging#/runtime/this-firefox`
2. **临时载入附加组件** → 选 `plugin/dist/firefox/manifest.json`
3. 长期使用需签名：`npx web-ext build --source-dir plugin/dist/firefox`
   （Firefox 与 Chrome 的差异只在清单：Firefox 用 event page 而非 service worker，
   所以 `manifest.firefox.json` 单独一份；打包脚本会自动改名成 `manifest.json`。）

---

## 2. 与墨读联动（决定「什么叫生词」）

扩展的「生词」定义完全来自**墨读词库**：`已学 = 认识`、`在学 = 半熟（计入可理解度）`、`生词本 = 生词`。
三种来源，按需选择（设置页 → 词库联动）：

| 方式 | 说明 | 适合 |
|---|---|---|
| **自动联动本地服务** | 自动探测墨读桌面版（127.0.0.1:17890…）或网页版 `start-server`（8642…），读存档目录里的 `vocab.json` | 装了墨读，想要「改完词库即生效」 |
| **只用导入的词表** | 拖入墨读「导出备份」JSON / `vocab.json` / `vocab.csv` / 纯词表 txt；Chrome/Edge 还可直接**绑定存档目录**读取其中的 `vocab.json` | 没开墨读、或跨设备用一份词表 |
| **关闭联动** | 以空词库分析：所有词都算生词，只看「客观难度」 | 只想评估视频本身难度 |

> 词表缓存 30 分钟，点「重新同步」可立即拉取。

---

## 3. 等级口径（与墨读一致）

**可理解度** = （已学词次 + 在学词次）÷ 总词次，按**词次**统计（与阅读端 `computeBookStats` 同口径）：

| 等级 | 可理解度 | 区间 | 建议 |
|---|---|---|---|
| L1 轻松 | ≥ 98% | 自由阅读区 | 可当泛看/精听，词汇收益有限 |
| **L2 适中** | **95–98%** | **i+1 理想区** | **最值得看：生词占比恰到好处** |
| L3 偏难 | 90–95% | 教学挑战区 | 先扫一遍高频生词，或配合字幕精看 |
| L4 困难 | < 90% | 挫败区 | 不建议硬啃，换更简单的内容 |

**客观难度**（脱离个人词库）按「高频词占比」估算，阈值由 `tools/calibrate.mjs` 的实测样本校准
（电影 0.93 / vlog 0.88 / 教程 0.74 / 新闻科普 0.53 / 学术 0.30）：

| 档 | 常用词占比(前 2500) | CEFR 参考 |
|---|---|---|
| L1 入门 | ≥ 0.88 | A1–A2 |
| L2 基础 | 0.76–0.88 | A2–B1 |
| L3 进阶 | 0.62–0.76 | B1–B2 |
| L4 高阶 | 0.48–0.62 | B2–C1 |
| L5 学术/母语 | < 0.48 | C1+ |

分词、词形还原、覆盖率算法**逐行对齐** `web/js/util.js` 与 `web/js/reader.js`——
所以一个视频和一个电子书的等级可以直接横向比较。

---

## 4. 目录结构

```
plugin/
├─ manifest.json              Chrome / Edge 清单（MV3，service_worker）
├─ manifest.firefox.json      Firefox 清单（MV3，event page）
├─ build.mjs                  打包：dist/<目标>/ + zip（自带零依赖 ZIP 写入器）
├─ icons/                     16/32/48/128 PNG（由 tools/gen-icons.mjs 生成）
├─ data/
│  └─ freq-bands.json         高频词表（8107 词，双语料交集清洗；随仓库分发，运行时不联网）
├─ src/
│  ├─ shared/                 可被 Node 单测直接 import 的纯逻辑
│  │  ├─ text.js              分词 / 词形还原 / 覆盖率 / L1–L4 档位  ← 与阅读端同口径
│  │  ├─ freq.js              词频分层 / 客观难度 L1–L5
│  │  ├─ analyze.js           分析编排（文本画像 + 词频画像）
│  │  ├─ subs.js              站点识别 + YouTube json3/XML + B 站字幕轨选择与解析
│  │  ├─ vocab-source.js      本地服务探测/读取 + 备份 JSON / vocab.json / csv / txt 解析
│  │  ├─ store.js             chrome.storage 封装：设置 / 词表缓存 / 分析缓存
│  │  └─ api.js               browser/chrome 垫片（并在 Node 下安全降级）
│  ├─ background/sw.js        编排：取播放器数据 → 抓字幕 → 分析 → 缓存 + 角标
│  ├─ content/content.js      页面悬浮徽标 + 可展开面板（Shadow DOM 隔离样式）
│  ├─ popup/                  点扩展图标的弹出面板
│  └─ options/                设置页（联动 / 导入 / 显示 / 数据）
├─ tests/
│  ├─ test-core.mjs           核心单测（99 项）
│  ├─ test-integration.mjs    清单 + 依赖图 + 端到端管线（81 项，不需要浏览器）
│  └─ e2e-browser.mjs         真机 E2E：Edge + CDP 假视频页 + 假墨读服务
└─ tools/
   ├─ make-freq.mjs           生成 data/freq-bands.json（开发期跑一次）
   ├─ calibrate.mjs           客观难度阈值校准
   ├─ gen-icons.mjs           生成图标 PNG
   └─ check-syntax.mjs        语法检查（把 .js 当 ESM 解析）
```

---

## 5. 开发与测试

```bash
# 单元测试（99 项）
node plugin/tests/test-core.mjs
# 集成测试：清单字段/资源存在性、import 依赖图、HTML 资源、端到端分析管线（81 项）
node plugin/tests/test-integration.mjs
# 真机 E2E（需要 Edge；会自己起假墨读服务和假视频页）
node plugin/tests/e2e-browser.mjs
# 语法检查
node plugin/tools/check-syntax.mjs
# 重新生成图标 / 词表
node plugin/tools/gen-icons.mjs
node plugin/tools/make-freq.mjs           # 优先用 tools/_cache/，缺失才联网
```

无构建步骤：改完 `src/` 后在扩展管理页点「重新加载」即可。

---

## 6. 已知限制

- **需要字幕**。没有字幕时退化为「标题 + 简介」估算，面板会明确标注「样本很小」。B 站 AI 字幕通常需要登录。
- **B 站只有中文字幕**时不会硬算：面板会直接说明「无法评估英文生词量」，并列出该视频现有的字幕轨。
- **自动生成字幕**（YouTube ASR / B 站 `ai-*`）噪声较大，用词统计会略偏，面板会标注「自动生成」。
- **可理解度按词次统计**，因此高频功能词（the / of / to）会显著抬高覆盖率——这与墨读书籍难度口径一致，属刻意设计。
- Firefox < 128 不支持 `scripting.executeScript({world:'MAIN'})`，会自动走「扫描 `<script>` 标签」的兜底路径。
- 扩展只读词库、**不写**墨读任何数据；词表与分析缓存都只存在浏览器本地。
