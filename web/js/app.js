/* 墨读 InkRead — 应用入口 / 路由 */
window.IR = window.IR || {};

(async function init() {
  const mark = s => { document.documentElement.dataset.stage = s; };  /* 无头调试：启动阶段标记 */
  mark('1');
  IR.settings.load();
  IR.tts.load();

  mark('2');
  await IR.openDB();
  mark('3');
  await IR.vocab.reload();
  mark('4');

  /* 磁盘存档：探针 + 挂钩自动存档 + 本地为空时从存档还原（生词 / 书籍 / 设置） */
  try {
    await IR.filestore.init();
    const restored = await IR.filestore.restore();
    if (restored && (restored.vocab || restored.books || restored.settings)) {
      const parts = [];
      if (restored.settings) parts.push('设置');
      if (restored.vocab) parts.push(restored.vocab + ' 个单词');
      if (restored.books) parts.push(restored.books + ' 本书');
      IR.toast('已从存档还原：' + parts.join(' / '), 'ok');
    }
  } catch (e) { /* 存档不可用（如 file:// 打开）：不影响主功能 */ }
  mark('4b');

  /* 顶栏主题下拉 */
  const themeSel = IR.$('#themeSelect');
  themeSel.innerHTML = IR.THEMES.map(t => `<option value="${t.id}">${t.id === '0' ? t.name + '（默认）' : t.name}</option>`).join('');
  themeSel.value = IR.settings.data.theme;
  themeSel.addEventListener('change', () => IR.applyTheme(themeSel.value));
  IR.applyTheme(IR.settings.data.theme);

  mark('5');
  /* 词组索引预热（数据驱动词组识别）：后台先加载，读第一本书时通常已就绪 */
  if (IR.phrases && IR.phrases.ensure) IR.phrases.ensure().catch(() => {});
  IR.vocab.mount(IR.$('#vocabMount'));
  IR.vocab.mount(IR.$('#studyMount'), { fixed: 'new' });
  IR.settingsPage.mount(IR.$('#settingsMount'));
  IR.reader.bindShelf();
  IR.reader.bindPopup();
  IR.reader.bindM2();
  mark('6');
  IR.reader.initShelf();
  mark('7');

  /* ?demo=1 自动载入示例文章（快速体验）；&mode=page 直接进翻页模式 */
  if (new URLSearchParams(location.search).get('demo') === '1') {
    IR.reader.importDemo().then(() => {
      if (new URLSearchParams(location.search).get('mode') === 'page') IR.reader.toggleMode();
    });
  }

  /* 导航 */
  const navBtns = IR.$$('.nav-btn');
  navBtns.forEach(btn => btn.addEventListener('click', () => {
    navBtns.forEach(b => b.classList.toggle('active', b === btn));
    IR.$$('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + btn.dataset.page));
    if (btn.dataset.page === 'vocab' || btn.dataset.page === 'study') IR.vocab.reload().then(() => {
      /* 重新挂载列表（保持筛选） */
      const st = (btn.dataset.page === 'vocab' ? IR.$('#vocabMount') : IR.$('#studyMount'))._state;
      if (st) IR.vocab.renderList(st);
    });
    window.scrollTo(0, 0);
  }));

  /* 锚点直达：#vocab / #study / #settings / #reader */
  const applyHash = () => {
    const h = (location.hash || '').replace('#', '');
    const btn = h && IR.$(`.nav-btn[data-page="${h}"]`);
    if (btn) btn.click();
  };
  window.addEventListener('hashchange', applyHash);
  applyHash();

  /* 词库变化时同步统计 */
  document.addEventListener('ir:vocabchange', () => {
    /* 阅读中的着色通过 statusMap 实时生效，这里只刷新列表页 */
  });

  console.log('%c墨读 InkRead 就绪', 'color:#FAC775;font-weight:bold');
  document.documentElement.dataset.boot = '1';  /* 启动完成标记（供无头调试检测） */
})();
