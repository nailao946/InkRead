/* 墨读 InkRead — 主题系统
   5 套主题定义与切换。规范见 THEMES.md：
   任何新 UI 必须使用 CSS 变量，禁止硬编码色值，保证 5 套主题同步适配 */
window.IR = window.IR || {};

IR.THEMES = [
  {
    id: '0', name: '深琥珀',
    desc: '深灰底 + 琥珀点缀，默认主题',
    swatch: { bg: '#2C2C2A', panel: '#3A3A37', unknown: '#F09595', learning: '#85B7EB', known: '#D3D1C7', accent: '#FAC775' }
  },
  {
    id: 'A', name: '纸墨书卷',
    desc: '米白纸感 · 朱砂靛青 · 衬线气质',
    swatch: { bg: '#EDE6D6', panel: '#FAF6EC', unknown: '#B0392E', learning: '#2F5D8A', known: '#2B2823', accent: '#B0392E' }
  },
  {
    id: 'B', name: '极简清爽',
    desc: '纯白卡片 · 系统蓝 · 现代 SaaS 质感',
    swatch: { bg: '#F2F3F5', panel: '#FFFFFF', unknown: '#D93F3F', learning: '#378ADD', known: '#1F2329', accent: '#185FA5' }
  },
  {
    id: 'C', name: '暗夜纯黑',
    desc: 'OLED 纯黑 · 高饱和三色 · 夜间省电',
    swatch: { bg: '#000000', panel: '#0A0A0A', unknown: '#FF5A5A', learning: '#4DA3FF', known: '#D6D6D6', accent: '#8B5CF6' }
  },
  {
    id: 'D', name: '护眼米黄',
    desc: '米黄暖底 · 低对比 · 长时间精读',
    swatch: { bg: '#F1E7CE', panel: '#F6EFDC', unknown: '#A8402C', learning: '#48708F', known: '#4A4132', accent: '#8A6A3B' }
  }
];

IR.applyTheme = id => {
  const t = IR.THEMES.find(x => x.id === id) || IR.THEMES[0];
  document.documentElement.dataset.theme = t.id;
  IR.settings.data.theme = t.id;
  IR.settings.save();
  /* 用户自定义三色覆盖（优先于主题默认色） */
  const c = IR.settings.data.colors;
  const root = document.documentElement;
  root.style.removeProperty('--w-unknown');
  root.style.removeProperty('--w-learning');
  root.style.removeProperty('--w-known');
  if (c) {
    if (c.unknown) root.style.setProperty('--w-unknown', c.unknown);
    if (c.learning) root.style.setProperty('--w-learning', c.learning);
    if (c.known) root.style.setProperty('--w-known', c.known);
  }
  const sel = IR.$('#themeSelect');
  if (sel) sel.value = t.id;
  /* 让主题色立即反映到打开着的弹窗等浮层 */
  document.dispatchEvent(new CustomEvent('ir:themechange', { detail: t }));
};
