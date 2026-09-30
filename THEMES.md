# 墨读 InkRead — 主题规范（THEMES.md）

> **本文件是给「后续 AI / 开发者」看的维护契约。** 任何一次新增界面、组件、功能，
> 都必须保证 **5 套主题同步适配**，并同步更新本文件。请务必先读「维护契约」一节。

## 一、主题清单（共 5 套，默认主题为 0 深琥珀）

| 编号 | 名称 | 气质 | 适用场景 |
|---|---|---|---|
| `0` | 深琥珀 | 深灰底 + 琥珀点缀，工具感 | **默认主题**，日常暗色党 |
| `A` | 纸墨书卷 | 米白纸感 · 朱砂靛青 · 衬线书卷气 | 喜欢传统阅读质感 |
| `B` | 极简清爽 | 纯白卡片 · 系统蓝 · 现代 SaaS 质感 | 白天办公环境 |
| `C` | 暗夜纯黑 | OLED 纯黑 · 高饱和三色 | 夜读、OLED 屏省电 |
| `D` | 护眼米黄 | 米黄暖底 · 低对比 · Kindle 感 | 长时间精读 |

## 二、各主题精确色值

> 变量名即语义，含义见「变量清单」。所有颜色在 `css/app.css` 里以
> `:root[data-theme="X"] { ... }` 定义。

### 0 · 深琥珀（默认）
| 变量 | 值 | | 变量 | 值 |
|---|---|---|---|---|
| --bg | `#2C2C2A` | | --text | `#D3D1C7` |
| --bg-panel | `#3A3A37` | | --text-2 | `#B4B2A9` |
| --bg-raised | `#444441` | | --text-3 | `#888780` |
| --bg-hover | `#4A4A46` | | --accent | `#FAC775` |
| --bg-input | `#2C2C2A` | | --accent-2 | `#EF9F27` |
| --border | `#5F5E5A` | | --accent-ink | `#412402` |
| --border-soft | `#4A4945` | | --w-unknown(生词) | `#F09595` |
| --danger | `#E24B4A` | | --w-learning(在学) | `#85B7EB` |
| --success | `#97C459` | | --w-known(已学) | `#D3D1C7` |
| --radius | `10px` | | | |

### A · 纸墨书卷
| 变量 | 值 | | 变量 | 值 |
|---|---|---|---|---|
| --bg | `#EDE6D6` | | --text | `#2B2823` |
| --bg-panel | `#FAF6EC` | | --text-2 | `#7A7261` |
| --bg-raised | `#FFFFFF` | | --text-3 | `#A89D87` |
| --bg-hover | `#F3EDDF` | | --accent | `#B0392E` |
| --bg-input | `#FFFFFF` | | --accent-2 | `#8A2B22` |
| --border | `#D9CFBB` | | --accent-ink | `#FAF6EC` |
| --border-soft | `#E3DAC8` | | --w-unknown | `#B0392E` |
| --danger | `#B0392E` | | --w-learning | `#2F5D8A` |
| --success | `#3B6D11` | | --w-known | `#2B2823` |
| --radius | `6px` | | | |

### B · 极简清爽
| 变量 | 值 | | 变量 | 值 |
|---|---|---|---|---|
| --bg | `#F2F3F5` | | --text | `#1F2329` |
| --bg-panel | `#FFFFFF` | | --text-2 | `#8A9099` |
| --bg-raised | `#FFFFFF` | | --text-3 | `#B0B5BD` |
| --bg-hover | `#F2F3F5` | | --accent | `#185FA5` |
| --bg-input | `#FFFFFF` | | --accent-2 | `#378ADD` |
| --border | `#E1E3E8` | | --accent-ink | `#FFFFFF` |
| --border-soft | `#EEF0F3` | | --w-unknown | `#D93F3F` |
| --danger | `#D93F3F` | | --w-learning | `#378ADD` |
| --success | `#3B6D11` | | --w-known | `#1F2329` |
| --radius | `12px` | | | |

### C · 暗夜纯黑
| 变量 | 值 | | 变量 | 值 |
|---|---|---|---|---|
| --bg | `#000000` | | --text | `#EAEAEA` |
| --bg-panel | `#0A0A0A` | | --text-2 | `#9A9A9A` |
| --bg-raised | `#101010` | | --text-3 | `#7C7C7C` |
| --bg-hover | `#1A1A1A` | | --accent | `#8B5CF6` |
| --bg-input | `#0A0A0A` | | --accent-2 | `#B9A5FF` |
| --border | `#262626` | | --accent-ink | `#FFFFFF` |
| --border-soft | `#1F1F1F` | | --w-unknown | `#FF5A5A` |
| --danger | `#FF5A5A` | | --w-learning | `#4DA3FF` |
| --success | `#4ADE80` | | --w-known | `#D6D6D6` |
| --radius | `10px` | | | |

### D · 护眼米黄
| 变量 | 值 | | 变量 | 值 |
|---|---|---|---|---|
| --bg | `#F1E7CE` | | --text | `#4A4132` |
| --bg-panel | `#F6EFDC` | | --text-2 | `#8A7B5E` |
| --bg-raised | `#FFFDF3` | | --text-3 | `#B0A488` |
| --bg-hover | `#F1E7CE` | | --accent | `#8A6A3B` |
| --bg-input | `#FFFDF3` | | --accent-2 | `#6B5230` |
| --border | `#DECFA8` | | --accent-ink | `#FFFDF3` |
| --border-soft | `#E8DDC2` | | --w-unknown | `#A8402C` |
| --danger | `#A8402C` | | --w-learning | `#48708F` |
| --success | `#3B6D11` | | --w-known | `#4A4132` |
| --radius | `8px` | | | |

## 三、变量清单（语义）

| 变量 | 用途 |
|---|---|
| `--bg` | 页面背景（最深/最底） |
| `--bg-panel` | 面板 / 卡片 / 顶栏背景 |
| `--bg-raised` | 浮层 / 弹窗 / 输入控件背景（比 panel 更“浮起”） |
| `--bg-hover` | 悬停 / 选中态背景 |
| `--bg-input` | 输入框、下拉框背景 |
| `--border` | 常规边框 |
| `--border-soft` | 弱边框 / 分隔线 |
| `--text` / `--text-2` / `--text-3` | 主文字 / 次文字 / 提示文字 |
| `--accent` / `--accent-2` / `--accent-ink` | 强调色 / 强调色悬停 / 强调色上的文字 |
| `--w-unknown` / `--w-learning` / `--w-known` | **单词三色**：生词 / 在学 / 已学 |
| `--danger` / `--success` | 危险 / 成功语义色 |
| `--radius` | 组件圆角（各主题略有差异，形成气质差异） |

## 四、维护契约（新增功能时必读）

1. **只用 CSS 变量，禁止硬编码颜色。** 新增任何 UI 组件，一律引用上面的语义变量，
   不要写 `#fff`、`red` 之类的字面量。
2. **新增组件必须目检 5 套主题**（0/A/B/C/D 各切一遍），确认文字对比度足够、边框分明、
   弹窗/悬停态清晰。浅色主题（A/B/D）注意深色文字，深色主题（0/C）注意浅色文字。
3. **三色标注 `--w-unknown/learning/known` 是核心语义**，任何涉及“生词/在学/已学”的 UI
   （阅读着色、词库状态标签、图例、统计）都必须用这三个变量，不得另造颜色。
4. **`--radius` 各主题不同**：A=6、B=12、C=10、D=8、0=10。新增圆角元素时用 `var(--radius)`
   而不是写死像素。
5. **新增主题**：需在 `js/themes.js` 的 `IR.THEMES` 数组注册（含 `swatch` 预览色），
   在 `css/app.css` 增加 `:root[data-theme="X"]` 变量块，并在本文件补一行色值表。
6. **用户三色自定义**：运行时可通过 `--w-*` 内联覆盖（见 `js/themes.js` 的 `IR.applyTheme`），
   自定义色优先于主题默认色，对所有主题生效。改动这部分的逻辑时保持该优先级。
7. 每次改完，跑 `node tests/test-importers.mjs`（导入器回归），并在浏览器里切一遍主题。

## 五、界面结构（对应 5 套主题通用的布局）

- **顶栏**：Logo「墨」+ 标题 + 导航（阅读/词库/生词本/设置）+ 主题下拉。
- **阅读页**：书架（卡片网格 + 拖拽导入区 + 空态「载入示例文章」）→ 阅读视图
  （标题栏 + **朗读/暂停控制** + **本篇生词** 按钮 + 三色图例 + 文章 + 点词弹窗 + **划词翻译浮钮**）。
- **词库页 / 生词本页**：工具条（导入/导出 + 状态筛选 chips + 搜索）+ **批量操作条**（选中后出现）
  + 单词表格（复选/单词/释义/状态/来源/操作）。
- **本篇生词弹层**：按词频排序的生词列表 + 单个/全部标记。
- **设置页**：主题卡片（5 套）、三色自定义、TTS 音色语速、翻译接口（默认引擎 + 各家 Key）、存储与存档、数据备份。
- **点词弹窗**：单词 + 状态 + 音标位 + 发音/标记/生词本/**翻译**/剑桥跳转按钮。

移动端（≤760px）导航沉底为标签栏，其余布局自适应；移动端隐藏批量复选框列。

### M2 新增组件的变量使用记录

| 组件 | 用到的变量 |
|---|---|
| 朗读当前段高亮 `.reading-active` | `--bg-hover` 背景 + `--accent` 左侧内嵌条 |
| 划词翻译浮钮 `#selTransBtn` | `.btn-primary`（`--accent`/`--accent-ink`） |
| 批量操作条 `.batch-bar` | `--bg-hover` 底 + `--accent` 描边 |
| 生词清单弹层 `.wordlist/.wl-row` | `--border-soft` 分隔线、`--w-unknown` 单词色、`--text-3` 次要文字 |
| 表格复选列 `.v-chk`、选中行 `.row-selected` | `--accent`（accent-color）、`--bg-hover` |

> 新增组件时按此格式在本节补一行，保证 5 套主题可回归检查。
