/* 墨读 InkRead — 阅读器
   书架（封面/信息）+ 电子书导入 + 三色着色 + 点词弹窗
   M2.5：blocks 渲染（含图片）/ 目录 / 翻页·滚动模式 / 全文朗读 / 划词翻译 / 生词清单 */
window.IR = window.IR || {};

const DEMO_TEXT = `Chapter 1 · The Ascent

Emma had spent years nurturing this quiet ambition, and now the summit lay within reach. A strange trepidation crept over her — not fear, but the weight of expectation. She remained undaunted, tightening her grip on the icy rock, one deliberate move at a time, breath steady and heart full of an extraordinary, quiet joy.

Chapter 2 · The Valley Below

The valley below had shrunk to a map; the wind carried the scent of pine and cold stone. Every summit she had conquered seemed, from up here, less a triumph than a promise. The rope hummed against the anchor, resilient and familiar, and she trusted it the way one trusts an old friend who never speaks but always listens.

Chapter 3 · The Gathering Clouds

By noon the clouds gathered like an unruly crowd. She read the sky the way her father had taught her, watching the deliberate shift of light across the ridge. Somewhere far behind her, the world went on with its meetings and its noise, utterly unaware that a woman on a mountainside was learning, again, what her own resilience was worth.`;

IR.reader = {
  currentBook: null,
  blocks: [],
  rendered: 0,
  mode: 'scroll',   /* scroll | page */
  counts: { total: 0, unknown: 0, learning: 0, known: 0 },
  articleEl: null,

  /* ---------- 书架状态 / 分组 / 阅读统计工具 ---------- */
  shelfFilter: 'all',        /* all | __none__ | <groupId> */
  readStateText: { unread: '未读', reading: '在读', done: '已读' },
  _readStart: 0,
  _readTimer: null,
  _progTimer: null,

  groups() {
    const s = IR.settings.data;
    s.shelf = s.shelf || {};
    if (!Array.isArray(s.shelf.groups)) s.shelf.groups = [];
    return s.shelf.groups;
  },
  saveGroups() { IR.settings.save(); },
  groupName(id) { const g = this.groups().find(x => x.id === id); return g ? g.name : ''; },
  groupIcon(id) { const g = this.groups().find(x => x.id === id); return g ? (g.icon || '') : ''; },
  /* 可选分组图标（含"无图标"） */
  GROUP_ICONS: ['', '📁', '📚', '🌟', '🧙', '🚀', '🕵️', '🏰', '🌍', '🧠', '🎯', '❤️', '🔍', '🐉', '🌙'],
  newGroup(name, icon) {
    const g = {
      id: 'g_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      name: (name || '').trim() || '未命名分组',
      icon: icon || '', createdAt: Date.now()
    };
    this.groups().push(g);
    this.saveGroups();
    return g;
  },
  updateGroup(id, name, icon) {
    const g = this.groups().find(x => x.id === id);
    if (!g) return;
    if (name != null && name.trim()) g.name = name.trim();
    if (icon != null) g.icon = icon;
    this.saveGroups();
  },
  removeGroup(id) {
    const i = this.groups().findIndex(x => x.id === id);
    if (i < 0) return;
    this.groups().splice(i, 1);
    this.saveGroups();
    IR.bookStore.getAll().then(books => {
      books.filter(b => b.grpId === id).forEach(b => { b.grpId = ''; IR.bookStore.put(b); });
      if (this.shelfFilter === id) this.shelfFilter = 'all';
      this.initShelf();
    });
  },
  /* 新建 / 编辑分组弹窗（可选图标、可删除；opts.assignTo 表示建好后把某本书移入） */
  openGroupDialog(mode, groupId, opts) {
    const R = this;
    opts = opts || {};
    const g = mode === 'edit' ? this.groups().find(x => x.id === groupId) : null;
    if (mode === 'edit' && !g) return;
    let picked = g ? (g.icon || '') : (opts.icon || '');
    const iconHtml = R.GROUP_ICONS.map(ic =>
      `<button class="icon-opt${(ic || '') === picked ? ' active' : ''}" data-ic="${IR.esc(ic)}">${ic || '无'}</button>`).join('');
    IR.modal.open(`
      <h3 style="margin-top:0">${mode === 'edit' ? '编辑分组' : '新建分组'}</h3>
      <div class="bd-row"><span>名称</span><input class="input" data-gname value="${g ? IR.esc(g.name) : ''}" placeholder="例如：奇幻小说 / 待读清单" style="flex:1"></div>
      <div class="bd-row" style="align-items:flex-start"><span>图标</span><div class="icon-grid" data-icons>${iconHtml}</div></div>
      <div class="modal-foot">
        <button class="btn btn-primary" data-gsave>保存</button>
        ${mode === 'edit' ? '<button class="btn btn-sm btn-danger" data-gdel>删除分组</button>' : ''}
        <button class="btn btn-ghost" data-gcancel>取消</button>
      </div>`, box => {
      IR.$$('[data-ic]', box).forEach(btn => btn.addEventListener('click', () => {
        picked = btn.dataset.ic;
        IR.$$('[data-ic]', box).forEach(b => b.classList.toggle('active', b === btn));
      }));
      IR.$('[data-gcancel]', box).addEventListener('click', () => IR.modal.close());
      IR.$('[data-gsave]', box).addEventListener('click', async () => {
        const name = IR.$('[data-gname]', box).value.trim();
        if (!name) return IR.toast('请填写分组名称', 'err');
        if (mode === 'edit') {
          R.updateGroup(g.id, name, picked);
          IR.toast('分组已更新', 'ok');
        } else {
          const ng = R.newGroup(name, picked);
          if (opts.assignTo) await R.assignGroup(opts.assignTo, ng.id);
          IR.toast('分组「' + ng.name + '」已创建', 'ok');
        }
        IR.modal.close();
        R.initShelf();
      });
      const del = IR.$('[data-gdel]', box);
      if (del) del.addEventListener('click', () => {
        if (!confirm('删除分组「' + g.name + '」？组内书籍会回到「未分组」。')) return;
        R.removeGroup(g.id);
        IR.modal.close();
      });
    });
  },
  async assignGroup(bookId, groupId) {
    const b = await IR.bookStore.get(bookId);
    if (!b) return;
    b.grpId = groupId || '';
    await IR.bookStore.put(b);
    this.initShelf();
  },

  /* 阅读状态：手动优先，未手动设置时按进度推断 */
  readStateOf(b) {
    const st = b.readState;
    if (st === 'done' || st === 'reading' || st === 'unread') return st;
    if ((b.progress || 0) >= 0.995) return 'done';
    if ((b.progress || 0) > 0.001 || b.lastOpenedAt) return 'reading';
    return 'unread';
  },
  async setReadState(bookId, state) {
    const b = await IR.bookStore.get(bookId);
    if (!b) return;
    b.readState = state;
    if (state === 'done') { b.progress = 1; b.finishedAt = b.finishedAt || Date.now(); }
    if (state === 'unread') { b.progress = 0; b.finishedAt = 0; }
    if (state === 'reading' && (b.progress || 0) >= 0.995) b.progress = 0.99;
    await IR.bookStore.put(b);
    if (this.currentBook && this.currentBook.id === bookId) {
      Object.assign(this.currentBook, { readState: b.readState, progress: b.progress });
    }
    this.initShelf();
  },

  /* 阅读时长：进入书籍后累计，落库节流（避免把整本书反复写盘） */
  _startReadTimer(book) {
    this._stopReadTimer();
    this._readStart = Date.now();
    this._readTimer = setInterval(() => this._flushRead(), 60000);
  },
  _stopReadTimer() {
    if (this._readTimer) { clearInterval(this._readTimer); this._readTimer = null; }
  },
  _flushRead() {
    const b = this.currentBook;
    if (!b || !this._readStart) return;
    const now = Date.now();
    b.readSeconds = (b.readSeconds || 0) + Math.round((now - this._readStart) / 1000);
    b.lastOpenedAt = now;
    this._readStart = now;
    if ((b.progress || 0) >= 0.995) { b.readState = 'done'; b.finishedAt = b.finishedAt || now; }
    else if (!b.readState || b.readState === 'unread') b.readState = 'reading';
    IR.bookStore.put(b);
  },
  /* 进度落库节流：滚动/翻页时只在内存更新，最多每 3 秒写一次 */
  _saveProgressSoon() {
    if (this._progTimer) return;
    this._progTimer = setTimeout(() => {
      this._progTimer = null;
      const b = this.currentBook;
      if (!b) return;
      if ((b.progress || 0) >= 0.995) { b.readState = 'done'; b.finishedAt = b.finishedAt || Date.now(); }
      else if (!b.readState || b.readState === 'unread') b.readState = 'reading';
      IR.bookStore.put(b);
    }, 3000);
  },
  fmtDuration(sec) {
    sec = Math.round(sec || 0);
    if (sec <= 0) return '—';
    if (sec < 60) return sec + ' 秒';
    const m = Math.floor(sec / 60);
    if (m < 60) return m + ' 分钟';
    return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分钟';
  },
  fmtTime(ms) {
    if (!ms) return '—';
    const d = new Date(ms), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  },
  /* 兼容旧调用 */
  renameGroup(id, name) { this.updateGroup(id, name, undefined); },

  /* ---------- 词频统计 + 阶梯阅读法难度评估 ----------
     口径与阅读着色一致：已标记「已学」= 已知，已标记「在学」= 半知，
     词库里没有的 = 生词。覆盖率按【词次】算（教学法与 SSR/lexile 类指标都用词次覆盖）。 */
  wordStatusOf(word) {
    const map = IR.vocab.statusMap;
    for (const c of IR.lemmas(word)) {
      const st = map && map.get(c);
      if (st) return { key: c, status: st };
    }
    return { key: String(word).toLowerCase(), status: 'unknown' };
  },
  /* 阶梯阅读法档位（可理解输入阈值） */
  levelOf(coverage) {
    if (coverage >= 0.98) return { level: 1, text: '轻松', tier: '自由阅读区', desc: '可理解度 ≥98%：几乎不用查词，适合泛读、提速与保持语感。' };
    if (coverage >= 0.95) return { level: 2, text: '适中', tier: 'i+1 理想区', desc: '可理解度 95–98%：阶梯阅读法的黄金区间，少量生词正好用来扩展词汇。' };
    if (coverage >= 0.90) return { level: 3, text: '偏难', tier: '教学挑战区', desc: '可理解度 90–95%：需要边读边查，建议先攻高频生词再读，或每天只读一小节。' };
    return { level: 4, text: '困难', tier: '挫败区', desc: '可理解度 <90%：远超当前词汇量，建议先读更简单的书，或先把高频生词加入生词本。' };
  },
  async computeBookStats(book) {
    const text = book.text || (book.blocks || []).filter(b => b.t !== 'img').map(b => b.text || '').join(' ');
    const tokens = text.match(/[A-Za-z][A-Za-z'’\-]*/g) || [];
    const uniq = new Map();
    let ut = 0, lt = 0, kt = 0;
    for (const t of tokens) {
      const { key, status } = this.wordStatusOf(t);
      let e = uniq.get(key);
      if (!e) { e = { display: t, count: 0, status }; uniq.set(key, e); }
      e.count++;
      if (status === 'known') kt++;
      else if (status === 'learning') lt++;
      else ut++;
    }
    let uu = 0, lu = 0, ku = 0;
    uniq.forEach(e => { if (e.status === 'known') ku++; else if (e.status === 'learning') lu++; else uu++; });
    const total = tokens.length || 1;
    const coverage = (kt + lt) / total;
    const lv = this.levelOf(coverage);
    const top = Array.from(uniq.values()).filter(e => e.status === 'unknown')
      .sort((a, b) => b.count - a.count).slice(0, 12)
      .map(e => ({ w: e.display, c: e.count }));
    return {
      tokens: tokens.length, unique: uniq.size,
      unknown: uu, learning: lu, known: ku,
      unknownTok: ut, learningTok: lt, knownTok: kt,
      coverage: Math.round(coverage * 1000) / 1000,
      level: lv.level, levelText: lv.text, tier: lv.tier, levelDesc: lv.desc,
      topUnknown: top, at: Date.now()
    };
  },
  async refreshBookStats(book) {
    const stats = await this.computeBookStats(book);
    book.stats = stats;
    await IR.bookStore.put(book);
    return stats;
  },

  /* ---------- 书架 ---------- */
  /* 书卡（variant：full＝分组视图网格，compact＝分组框内横排） */
  _cardHtml(b, variant) {
    const st = this.readStateOf(b);
    const pct = Math.round((b.progress || 0) * 100);
    const cover = b.cover
      ? `<img class="book-cover-img" src="${b.cover}" alt="">`
      : `<div class="book-cover-img book-cover-fallback">${IR.esc((b.title || '?').slice(0, 1))}</div>`;
    const diff = (b.stats && b.stats.level)
      ? `<span class="diff-badge d${b.stats.level}" title="难度：${IR.esc(b.stats.levelText)} · ${IR.esc(b.stats.tier || '')}">${IR.esc(b.stats.levelText)}</span>` : '';
    return `
      <div class="book-card ${variant}" data-id="${b.id}">
        <div class="book-cover">
          ${cover}
          <span class="book-state ${st}" title="阅读状态：${this.readStateText[st]}">${this.readStateText[st]}</span>
        </div>
        <div class="book-body">
          <div class="book-title" title="${IR.esc(b.title)}">${IR.esc(b.title)}</div>
          <div class="book-author" title="${IR.esc(b.author || '未知作者')}">${b.author ? IR.esc(b.author) : '未知作者'}</div>
          <div class="book-meta">
            <span class="fmt-badge">${IR.esc(b.fmt || '')}</span>
            <span>${(b.wordCount || 0).toLocaleString()} 词</span>
            ${diff}
          </div>
          <div class="book-prog st-${st}"><i style="width:${pct}%"></i></div>
          <div class="book-prog-text">
            <span class="bp-pct">已读 <b>${pct}%</b></span>
            <span class="book-detail-hint" data-detail>详情 ›</span>
          </div>
        </div>
        ${variant === 'full' ? '<button class="book-more" data-detail title="详情 / 分组 / 删除">⋯</button>' : ''}
      </div>`;
  },
  /* 分组框（微信读书式）：标题行 + 横排书卡 */
  _groupFrameHtml(g, books) {
    const title = g ? ((g.icon ? g.icon + ' ' : '') + IR.esc(g.name)) : '未分组';
    return `
      <section class="group-frame">
        <div class="frame-head">
          <span class="frame-title"${g ? ` data-goto="${g.id}"` : ''}>${title}</span>
          <span class="frame-count">${books.length} 本</span>
          ${g ? `<button class="frame-more" data-folder-menu="${g.id}" title="重命名 / 图标 / 删除">⋯</button>` : ''}
          ${books.length > 4 ? `<button class="frame-all" data-goto="${g.id}">查看全部 ›</button>` : ''}
        </div>
        ${books.length
          ? `<div class="frame-row">${books.map(b => this._cardHtml(b, 'compact')).join('')}</div>`
          : '<div class="frame-empty">这个分组还没有书 —— 在书籍「详情」里移入</div>'}
      </section>`;
  },

  async initShelf() {
    const listEl = IR.$('#shelfList');
    const barEl = IR.$('#shelfGroups');
    const books = await IR.bookStore.getAll();
    books.sort((a, b) => b.addedAt - a.addedAt);
    IR.$('#shelfEmptyActions').hidden = books.length > 0;

    if (!books.length) {
      barEl.innerHTML = '';
      listEl.className = 'shelf-list';
      listEl.innerHTML = `<div class="book-empty">书架空空如也<br><span style="font-size:.82rem">导入一本英文电子书开始阅读，或点下方按钮先看示例</span></div>`;
      return;
    }

    const groups = this.groups();

    if (this.shelfFilter === 'all') {
      /* 全部视图：按「分组框」排布，每框一行（微信读书式） */
      barEl.innerHTML = `<button class="group-new" data-group-new>＋ 新建分组</button>`;
      const frames = groups.map(g => this._groupFrameHtml(g, books.filter(b => b.grpId === g.id)));
      const un = books.filter(b => !b.grpId);
      if (un.length || !groups.length) frames.push(this._groupFrameHtml(null, un));
      listEl.className = 'shelf-frames';
      listEl.innerHTML = frames.join('');
    } else {
      /* 分组视图：网格显示该组书籍 */
      const g = groups.find(x => x.id === this.shelfFilter);
      const inGroup = books.filter(b => b.grpId === this.shelfFilter);
      barEl.innerHTML =
        `<button class="group-chip" data-back>‹ 全部</button>` +
        `<span class="group-current">${g && g.icon ? g.icon + ' ' : ''}${IR.esc(g ? g.name : '')}<b>${inGroup.length}</b></span>`;
      listEl.className = 'shelf-list';
      listEl.innerHTML = inGroup.length
        ? inGroup.map(b => this._cardHtml(b, 'full')).join('')
        : `<div class="book-empty">这个分组里还没有书<br><span style="font-size:.82rem">在书籍「详情」里把书移入本组</span></div>`;
    }

    /* 交互（事件委托） */
    listEl.onclick = e => {
      const del = e.target.closest('[data-detail]');
      if (del) { e.stopPropagation(); const c = del.closest('[data-id]'); if (c) this.openBookDetail(c.dataset.id); return; }
      const go = e.target.closest('[data-goto]');
      if (go) { this.shelfFilter = go.dataset.goto; this.initShelf(); return; }
      const fm = e.target.closest('[data-folder-menu]');
      if (fm) { e.stopPropagation(); this.openGroupDialog('edit', fm.dataset.folderMenu); return; }
      const card = e.target.closest('.book-card');
      if (card) this.openBook(card.dataset.id);
    };
    listEl.oncontextmenu = e => {
      const card = e.target.closest('.book-card');
      if (!card) return;
      e.preventDefault();
      this.openBookDetail(card.dataset.id);
    };
    barEl.onclick = e => {
      if (e.target.closest('[data-group-new]')) this.openGroupDialog('new');
      else if (e.target.closest('[data-back]')) { this.shelfFilter = 'all'; this.initShelf(); }
    };
  },

  /* ---------- 书籍详情（进度 / 时长 / 状态 / 分组 / 词频难度） ---------- */
  _statsHtml(s) {
    const pct = Math.round((s.coverage || 0) * 1000) / 10;
    return `
      <div class="bd-stat-grid">
        <div class="bd-stat un"><b>${s.unknown.toLocaleString()}</b><span>生词</span></div>
        <div class="bd-stat le"><b>${s.learning.toLocaleString()}</b><span>在学</span></div>
        <div class="bd-stat kn"><b>${s.known.toLocaleString()}</b><span>已学</span></div>
        <div class="bd-stat to"><b>${s.unique.toLocaleString()}</b><span>全书不同词</span></div>
      </div>
      <div class="bd-diff d${s.level}">
        <b>难度：${IR.esc(s.levelText)}</b><span>${IR.esc(s.tier || '')}</span>
      </div>
      <div class="bd-cov">
        <div class="bd-cov-bar"><i class="d${s.level}" style="width:${Math.min(100, pct)}%"></i></div>
        <div class="bd-cov-text">可理解度 <b>${pct}%</b>（已学＋在学的词次占比）· 共 ${s.tokens.toLocaleString()} 词次</div>
      </div>
      <p class="bd-diff-desc">${IR.esc(s.levelDesc || '')}</p>
      <div class="bd-cov-scale">阶梯阅读法：≥98% 自由阅读 · 95–98% i+1 理想 · 90–95% 教学挑战 · &lt;90% 挫败</div>
      ${s.topUnknown && s.topUnknown.length ? `
        <div class="bd-top">
          <div class="bd-top-head">高频生词 Top ${s.topUnknown.length}（先攻这些，收益最大）
            <button class="btn btn-sm" data-add-top>全部加入生词本</button>
          </div>
          <div class="bd-chips">${s.topUnknown.map(t => `<span class="bd-chip" title="出现 ${t.c} 次">${IR.esc(t.w)}<i>×${t.c}</i></span>`).join('')}</div>
        </div>` : '<div class="bd-top bd-top-none">这本书没有生词 —— 全在你的词库里，可以放心读。</div>'}`;
  },
  _renderStats(box, book, force) {
    const el = IR.$('[data-bd-stats]', box);
    if (!el) return;
    const paint = s => { el.innerHTML = s ? this._statsHtml(s) : '<div class="bd-stat-empty">正在统计全书词频…</div>'; };
    if (book.stats && !force) {
      paint(book.stats);
      if (!book.stats.topUnknown || !book.stats.topUnknown.length) { /* 老数据：重算一次 */ this._renderStats(box, book, true); }
      return;
    }
    paint(null);
    setTimeout(async () => {
      try {
        const s = await this.refreshBookStats(book);
        paint(s);
        IR.toast(`难度统计完成：${s.levelText} · 可理解度 ${Math.round(s.coverage * 100)}%`, 'ok');
        this.initShelf();     /* 让书架上的难度徽标同步 */
      } catch (e) {
        el.innerHTML = '<div class="bd-stat-empty">统计失败：' + IR.esc(e.message) + '</div>';
      }
    }, 30);
  },

  async openBookDetail(id) {
    const b = await IR.bookStore.get(id);
    if (!b) return IR.toast('书本不存在', 'err');
    const R = this;
    const st = this.readStateOf(b);
    const pct = Math.round((b.progress || 0) * 100);
    const grpOpts = ['<option value="">（未分组）</option>']
      .concat(this.groups().map(g => `<option value="${g.id}"${b.grpId === g.id ? ' selected' : ''}>${g.icon ? g.icon + ' ' : ''}${IR.esc(g.name)}</option>`))
      .join('');
    IR.modal.open(`
      <div class="bd-head">
        <div class="bd-cover">${b.cover ? `<img src="${b.cover}" alt="">` : `<div class="book-cover-img book-cover-fallback">${IR.esc((b.title || '?').slice(0, 1))}</div>`}</div>
        <div class="bd-info">
          <h3 class="bd-title">${IR.esc(b.title)}</h3>
          <div class="bd-author">${b.author ? IR.esc(b.author) : '未知作者'} · ${IR.esc(b.fmt || '')} · ${(b.wordCount || 0).toLocaleString()} 词</div>
          <div class="bd-row"><span>阅读状态</span><b class="bd-state ${st}">${this.readStateText[st]}</b></div>
          <div class="bd-row"><span>阅读进度</span><b>${pct}%</b></div>
          <div class="bd-bar st-${st}"><i style="width:${pct}%"></i></div>
        </div>
      </div>
      <div class="bd-grid">
        <div class="bd-cell"><span>累计阅读</span><b>${this.fmtDuration(b.readSeconds)}</b></div>
        <div class="bd-cell"><span>最后阅读</span><b>${this.fmtTime(b.lastOpenedAt)}</b></div>
        <div class="bd-cell"><span>加入书架</span><b>${this.fmtTime(b.addedAt)}</b></div>
        <div class="bd-cell"><span>读完时间</span><b>${this.fmtTime(b.finishedAt)}</b></div>
      </div>
      <div class="bd-row"><span>分组</span>
        <select class="input" data-bd-group style="min-width:170px">${grpOpts}</select>
        <button class="btn btn-sm" data-bd-newgroup>新建分组</button>
      </div>

      <div class="bd-section">
        <div class="bd-section-head">词汇难度（按你当前的词汇量统计）
          <button class="btn btn-sm btn-ghost" data-bd-restat title="重新扫描全书">重新统计</button>
        </div>
        <div data-bd-stats><div class="bd-stat-empty">正在统计全书词频…</div></div>
      </div>

      <div class="modal-foot bd-foot">
        <button class="btn btn-primary" data-bd-open>继续阅读</button>
        <button class="btn btn-sm" data-bd-state="reading">标为在读</button>
        <button class="btn btn-sm" data-bd-state="done">标为已读</button>
        <button class="btn btn-sm" data-bd-state="unread">标为未读</button>
        <button class="btn btn-sm btn-danger" data-bd-del>删除本书</button>
        <button class="btn btn-ghost" data-bd-close>关闭</button>
      </div>`, box => {
      IR.$('[data-bd-close]', box).addEventListener('click', () => IR.modal.close());
      IR.$('[data-bd-open]', box).addEventListener('click', () => { IR.modal.close(); R.openBook(b.id); });
      IR.$('[data-bd-group]', box).addEventListener('change', async e => {
        await R.assignGroup(b.id, e.target.value);
        IR.toast(e.target.value ? '已移入分组「' + R.groupName(e.target.value) + '」' : '已移出分组', 'ok');
      });
      IR.$('[data-bd-newgroup]', box).addEventListener('click', () => R.openGroupDialog('new', null, { assignTo: b.id }));
      IR.$('[data-bd-restat]', box).addEventListener('click', () => R._renderStats(box, b, true));
      IR.$$('[data-bd-state]', box).forEach(btn => btn.addEventListener('click', async () => {
        await R.setReadState(b.id, btn.dataset.bdState);
        IR.toast('已标记为「' + R.readStateText[btn.dataset.bdState] + '」', 'ok');
        IR.modal.close();
      }));
      IR.$('[data-bd-del]', box).addEventListener('click', async () => {
        if (!confirm(`删除《${b.title}》？词库标记不受影响。`)) return;
        await IR.bookStore.remove(b.id);
        IR.modal.close();
        IR.toast('已从书架删除', 'ok');
        R.initShelf();
      });
      /* 高频生词一键加入生词本 */
      box.addEventListener('click', async e => {
        if (!e.target.closest('[data-add-top]')) return;
        const top = (b.stats && b.stats.topUnknown) || [];
        if (!top.length) return;
        for (const t of top) await IR.vocab.mark(t.w.toLowerCase(), t.w, 'new');
        IR.toast(`已把 ${top.length} 个高频生词加入生词本`, 'ok');
        R._renderStats(box, b, true);
      });
      R._renderStats(box, b, false);
    });
  },

  async importBooks(files) {
    for (const file of files) {
      const ext = '.' + (file.name.split('.').pop() || '').toLowerCase();
      try {
        IR.toast('正在解析 ' + file.name + ' …');
        const res = await IR.importers.importBookFile(file);
        const words = (res.text.match(/[A-Za-z][A-Za-z'’\-]*/g) || []).length;
        const blocks = res.blocks && res.blocks.length ? res.blocks : res.text.split(/\n{2,}/).filter(Boolean).map(t => ({ t: 'p', text: t }));
        const book = {
          id: 'bk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
          title: res.title || file.name, author: res.author || '', description: res.description || '',
          cover: res.cover || '', fmt: ext.slice(1).toUpperCase(),
          text: res.text, blocks, toc: res.toc || [], wordCount: words, addedAt: Date.now(), progress: 0
        };
        await IR.bookStore.put(book);
        IR.toast(`《${book.title}》导入成功 · ${words.toLocaleString()} 词`, 'ok');
      } catch (err) {
        console.error('[Import]', file.name, err);
        /* 失败详情写到存档目录 logs/，便于定位（没有本地服务时静默跳过） */
        let logged = false;
        try {
          logged = await IR.filestore.logImportError({
            file: file.name, size: file.size, ext,
            error: (err && err.message) || String(err), stack: (err && err.stack) || ''
          });
        } catch (e) { /* 忽略 */ }
        IR.toast(`${file.name} 导入失败：${err.message}`, 'err');
        if (logged) IR.toast('失败详情已写入存档目录 logs/（可在设置 → 存储与存档 → 打开文件夹查看）', 'err');
      }
    }
    this.initShelf();
  },

  async importDemo() {
    const exist = await IR.bookStore.get('demo');
    if (exist && exist.toc && exist.toc.length && exist.blocks && exist.blocks.length) {
      return this.openBook('demo');
    }
    const words = (DEMO_TEXT.match(/[A-Za-z][A-Za-z'’\-]*/g) || []).length;
    const blocks = [];
    DEMO_TEXT.split(/\n{2,}/).filter(Boolean).forEach(seg => {
      const t = seg.trim();
      blocks.push(/^Chapter\b/.test(t) ? { t: 'h', text: t } : { t: 'p', text: t });
    });
    await IR.bookStore.put({
      id: 'demo', title: '示例 · The Ascent（山巅）', author: 'Demo Author', description: '内置示例文章', cover: '',
      fmt: 'DEMO', blocks, toc: IR.importers.buildToc(blocks), wordCount: words, addedAt: Date.now(), progress: 0
    });
    this.openBook('demo');
  },

  bindShelf() {
    const input = IR.$('#bookFileInput');
    IR.$('#btnImportBook').addEventListener('click', () => input.click());
    input.addEventListener('change', () => { this.importBooks(input.files); input.value = ''; });
    IR.$('#btnDemo').addEventListener('click', () => this.importDemo());
    const dz = IR.$('#dropzone');
    ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('dragover'); }));
    dz.addEventListener('drop', e => {
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length) this.importBooks(files);
    });
    ['dragover', 'drop'].forEach(ev => window.addEventListener(ev, e => e.preventDefault()));
    IR.$('#btnBackShelf').addEventListener('click', () => { this.speech.stop(); this.showShelf(); });
  },

  showShelf() {
    this._flushRead();          /* 回到书架：把阅读时长与进度落库 */
    this._stopReadTimer();
    IR.$('#shelfView').hidden = false;
    IR.$('#readingView').hidden = true;
    IR.$('#tocPanel').hidden = true;
    IR.$('#tocMask').hidden = true;
    IR.$('#tocFab').hidden = true;
    IR.$('#tocSide').hidden = true;
    IR.$('#fontPanel').hidden = true;
    if (this.articleEl) this.articleEl.innerHTML = '';
    this.initShelf();
  },

  /* ---------- 打开书 + 着色渲染 ---------- */
  async openBook(id) {
    const book = await IR.bookStore.get(id);
    if (!book) return IR.toast('书本不存在', 'err');
    this.currentBook = book;
    /* 打开即视为「在读」；记录最后阅读时间并开始累计阅读时长 */
    book.lastOpenedAt = Date.now();
    if (!book.readState || book.readState === 'unread') book.readState = 'reading';
    IR.bookStore.put(book);
    this._startReadTimer(book);
    this.blocks = (book.blocks && book.blocks.length) ? book.blocks : (book.text || '').split(/\n{2,}/).filter(Boolean).map(t => ({ t: 'p', text: t }));
    this.rendered = 0;
    this.counts = { total: 0, unknown: 0, learning: 0, known: 0 };
    this.mode = 'scroll';
    this.articleEl = IR.$('#article');
    this.articleEl.innerHTML = '';
    this.pageEls = null;
    this.pages = [];
    this._applyMode();
    IR.$('#shelfView').hidden = true;
    IR.$('#readingView').hidden = false;
    IR.$('#tocPanel').hidden = true;
    IR.$('#readingTitle').textContent = book.title;
    this._wordStatus = word => {
      const map = IR.vocab.statusMap;
      for (const c of IR.lemmas(word)) {
        const st = map && map.get(c);
        if (st) return { key: c, status: st };
      }
      return { key: word.toLowerCase(), status: 'unknown' };
    };
    this._renderToc();
    this._appendBlocks();
    this._updateStats();
    this._updateProgress();
    if (book.progress && this.mode === 'scroll') requestAnimationFrame(() => window.scrollTo(0, (document.body.scrollHeight - innerHeight) * book.progress));
    else window.scrollTo(0, 0);
    if (!this._io) {
      this._io = new IntersectionObserver(entries => {
        if (entries[0].isIntersecting && this.rendered < this.blocks.length) {
          this._appendBlocks();
          this._updateStats();
        }
      }, { rootMargin: '600px' });
      this._io.observe(IR.$('#articleSentinel'));
    }
  },

  _ensureRendered(idx) {
    while (this.rendered <= idx && this.rendered < this.blocks.length) this._appendBlocks();
  },

  _appendBlocks() {
    const CH = 60;
    const frag = document.createDocumentFragment();
    const end = Math.min(this.rendered + CH, this.blocks.length);
    for (let i = this.rendered; i < end; i++) {
      const b = this.blocks[i];
      if (b.t === 'img') {
        if (b.data) {
          const fig = IR.el('figure', { class: 'block-figure', 'data-bi': i });
          fig.appendChild(IR.el('img', { src: b.data, alt: b.alt || '', loading: 'lazy' }));
          if (b.alt) fig.appendChild(IR.el('figcaption', {}, IR.esc(b.alt)));
          frag.appendChild(fig);
        }
        continue;
      }
      const el = IR.el(b.t === 'h' ? 'h3' : 'p', { class: b.t === 'h' ? 'block-heading' : '', 'data-bi': i });
      for (const seg of IR.tokenize(b.text)) {
        if (!IR.WORD_RE.test(seg)) { el.appendChild(document.createTextNode(seg)); continue; }
        const { key, status } = this._wordStatus(seg);
        this.counts.total++;
        if (this.counts[status] != null) this.counts[status]++;
        el.appendChild(IR.el('span', { class: 'w w-' + status, 'data-w': seg, 'data-k': key }, IR.esc(seg)));
      }
      frag.appendChild(el);
    }
    this.rendered = end;
    this.articleEl.appendChild(frag);
  },

  _updateStats() {
    const c = this.counts;
    IR.$('#readingStats').innerHTML =
      `<span class="c-unknown">生词 ${c.unknown.toLocaleString()}</span> ·
       <span class="c-learning">在学 ${c.learning.toLocaleString()}</span> ·
       <span class="c-known">已学 ${c.known.toLocaleString()}</span> ·
       共 ${c.total.toLocaleString()} 词`;
  },

  _restyleWord(key, status) {
    IR.$$(`.article .w[data-k="${CSS.escape(key)}"]`).forEach(sp => {
      sp.classList.remove('w-unknown', 'w-learning', 'w-known');
      sp.classList.add('w-' + status);
    });
  },

  _updateAfterMark() {
    const c = { total: this.counts.total, unknown: 0, learning: 0, known: 0 };
    IR.$$('.article .w').forEach(sp => {
      const st = sp.className.match(/w-(unknown|learning|known)/);
      if (st) c[st[1]]++;
    });
    this.counts = c;
    this._updateStats();
  },

  /* ---------- 目录 ---------- */
  _renderToc() {
    const toc = this.currentBook.toc || [];
    const html = toc.length
      ? toc.map((t, i) => `<div class="toc-item" data-bi="${t.bi}">${IR.esc(t.title)}</div>`).join('')
      : '<div class="toc-empty">本书未识别到目录</div>';
    const bind = listEl => {
      listEl.innerHTML = html;
      listEl.onclick = e => {
        const item = e.target.closest('.toc-item');
        if (!item) return;
        const bi = +item.dataset.bi;
        this.closeToc();
        this.jumpToBlock(bi);
      };
    };
    bind(IR.$('#tocList'));
    bind(IR.$('#tocSideList'));
    this._applyTocLayout();
  },
  _applyTocLayout() {
    const hasToc = !!(this.currentBook && this.currentBook.toc && this.currentBook.toc.length);
    const pinned = !!IR.settings.data.tocPinned;
    IR.$('#tocSide').hidden = !(pinned && hasToc);
    IR.$('#tocFab').hidden = !(hasToc && !pinned);
  },
  pinToc() {
    IR.settings.data.tocPinned = true;
    IR.settings.save();
    this.closeToc();
    this._applyTocLayout();
  },
  unpinToc() {
    IR.settings.data.tocPinned = false;
    IR.settings.save();
    this._applyTocLayout();
  },
  openToc() {
    IR.$('#tocPanel').hidden = false;
    IR.$('#tocMask').hidden = false;
    requestAnimationFrame(() => document.body.classList.add('toc-open'));
  },
  closeToc() {
    document.body.classList.remove('toc-open');
    setTimeout(() => { IR.$('#tocPanel').hidden = true; IR.$('#tocMask').hidden = true; }, 260);
  },
  jumpToBlock(bi) {
    if (this.mode === 'page') {
      const idx = this.pages.findIndex(page => page.some(el => +el.dataset.bi === bi));
      if (idx >= 0) { this.pageIndex = idx; this._showPage(); }
      return;
    }
    this._ensureRendered(bi);
    const el = this.articleEl.querySelector(`[data-bi="${bi}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  },

  /* ---------- 阅读模式（滚动 / 翻页） ---------- */
  _applyMode() {
    IR.$('#btnMode').textContent = this.mode === 'scroll' ? '翻页模式' : '滚动模式';
    IR.$('#pageIndicator').hidden = this.mode !== 'page';
    IR.$('#pageNav').hidden = this.mode !== 'page';
    const art = this.articleEl;
    art.classList.toggle('paged', this.mode === 'page');
    /* 滚动模式恢复普通文档流 */
    if (this.pageEls && this.mode === 'scroll') {
      const frag = document.createDocumentFragment();
      this.pageEls.forEach(pg => Array.from(pg.children).forEach(el => frag.appendChild(el)));
      art.innerHTML = '';
      art.appendChild(frag);
      this.pageEls = null;
      this.pages = [];
    }
  },
  toggleMode() {
    if (this.mode === 'scroll') { this.mode = 'page'; this._toPageMode(); }
    else { this.mode = 'scroll'; this._toScrollMode(); }
    this._applyMode();
  },
  _pageHeight() {
    const art = this.articleEl;
    const cs = getComputedStyle(art);
    return art.clientHeight - parseFloat(cs.paddingTop || 0) - parseFloat(cs.paddingBottom || 0) - 4;
  },
  _toPageMode() {
    const art = this.articleEl;
    while (this.rendered < this.blocks.length) this._appendBlocks();
    /* 摊平（若曾分页） */
    if (this.pageEls) {
      const frag = document.createDocumentFragment();
      this.pageEls.forEach(pg => Array.from(pg.children).forEach(el => frag.appendChild(el)));
      art.innerHTML = '';
      art.appendChild(frag);
    }
    art.classList.add('paged');
    art.style.position = 'relative';
    /* 测量切页（基于 offsetTop） */
    const pageH = this._pageHeight();
    const children = Array.from(art.children);
    const pages = [];
    let cur = [], baseTop = -1;
    for (const el of children) {
      if (!cur.length) { cur.push(el); baseTop = el.offsetTop; continue; }
      if (el.offsetTop - baseTop + el.offsetHeight > pageH) { pages.push(cur); cur = [el]; baseTop = el.offsetTop; }
      else cur.push(el);
    }
    if (cur.length) pages.push(cur);
    this.pages = pages;
    /* 重排为 page 容器 */
    art.innerHTML = '';
    this.pageEls = pages.map((blocks, i) => {
      const pg = IR.el('div', { class: 'reader-page', 'data-page': i });
      if (i !== 0) pg.hidden = true;
      blocks.forEach(el => pg.appendChild(el));
      art.appendChild(pg);
      return pg;
    });
    this.pageIndex = 0;
    this._updatePageUI();
  },
  _toScrollMode() {
    const art = this.articleEl;
    const totalPages = this.pages ? this.pages.length : 1;
    const pageIdx = this.pageIndex;
    if (this.pageEls) {
      const frag = document.createDocumentFragment();
      this.pageEls.forEach(pg => Array.from(pg.children).forEach(el => frag.appendChild(el)));
      art.innerHTML = '';
      art.classList.remove('paged');
      art.appendChild(frag);
      this.pageEls = null;
      this.pages = [];
    }
    const max = document.body.scrollHeight - innerHeight;
    const ratio = totalPages > 1 ? pageIdx / (totalPages - 1) : 0;
    requestAnimationFrame(() => window.scrollTo(0, max * Math.min(1, ratio)));
  },
  _showPage() {
    if (!this.pageEls) return;
    this.pageEls.forEach((pg, i) => { pg.hidden = i !== this.pageIndex; });
    this._updatePageUI();
    this._updateProgress();
    /* 存进度（按页）：内存即时更新，落库节流 3 秒 */
    if (this.currentBook) {
      this.currentBook.progress = this.pageEls.length > 1 ? this.pageIndex / (this.pageEls.length - 1) : 0;
      this._saveProgressSoon();
    }
  },
  _updatePageUI() {
    IR.$('#pageIndicator').textContent = `${this.pageIndex + 1} / ${this.pageEls ? this.pageEls.length : 1}`;
  },
  nextPage() { if (this.mode === 'page' && this.pageEls && this.pageIndex < this.pageEls.length - 1) { this.pageIndex++; this._showPage(); } },
  prevPage() { if (this.mode === 'page' && this.pageIndex > 0) { this.pageIndex--; this._showPage(); } },
  bindPageNav() {
    this.articleEl = IR.$('#article');
    /* 点击左右 30% 区域翻页（不点单词） */
    this.articleEl.addEventListener('click', e => {
      if (this.mode !== 'page') return;
      if (e.target.closest('.w') || e.target.closest('.word-popup') || e.target.closest('.block-figure img')) return;
      const rect = this.articleEl.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (x < rect.width * 0.28) this.prevPage();
      else if (x > rect.width * 0.72) this.nextPage();
    });
    /* 键盘左右翻页 */
    document.addEventListener('keydown', e => {
      if (this.mode !== 'page' || IR.$('#readingView').hidden) return;
      if (e.key === 'ArrowLeft') this.prevPage();
      if (e.key === 'ArrowRight') this.nextPage();
    });
    /* 触屏滑动 */
    let tx = 0;
    this.articleEl.addEventListener('touchstart', e => { tx = e.touches[0].clientX; }, { passive: true });
    this.articleEl.addEventListener('touchend', e => {
      if (this.mode !== 'page') return;
      const dx = e.changedTouches[0].clientX - tx;
      if (Math.abs(dx) > 50) { dx < 0 ? this.nextPage() : this.prevPage(); }
    }, { passive: true });
    IR.$('#btnPrevPage').addEventListener('click', () => this.prevPage());
    IR.$('#btnNextPage').addEventListener('click', () => this.nextPage());
  },

  /* ---------- 点词弹窗 ---------- */
  bindPopup() {
    const popup = IR.$('#wordPopup');
    document.addEventListener('click', e => {
      const sel = window.getSelection();
      const selLen = sel ? sel.toString().trim().length : 0;
      const w = e.target.closest('.w');
      if (w && !IR.$('#readingView').hidden && selLen <= 1 && !e.target.closest('#selTransBtn')) {
        this._openPopup(w, popup);
        return;
      }
      if (!e.target.closest('.word-popup') && !e.target.closest('#selTransBtn')) this._closePopup(popup);
    });
    popup.addEventListener('click', async e => {
      const op = e.target.closest('[data-op]');
      if (!op) return;
      const word = popup.dataset.w, key = popup.dataset.k, display = popup.dataset.d;
      const action = op.dataset.op;
      if (action === 'speak') return IR.tts.speak(word);
      if (action === 'cam') return window.open('https://dictionary.cambridge.org/dictionary/english/' + encodeURIComponent(word.toLowerCase()), '_blank');
      if (action === 'close') return this._closePopup(popup);
      if (action === 'trans') {
        const box = IR.$('[data-trans]', popup);
        box.hidden = false;
        box.innerHTML = '<span class="wp-trans-note">翻译中…</span>';
        try {
          const r = await this._translateWord(word);
          box.innerHTML = `<b>${IR.esc(r.engine)}</b>：` + IR.escLines(r.text);
        } catch (err) { box.innerHTML = `<span style="color:var(--danger)">${IR.esc(err.message)}</span>`; }
        return;
      }
      if (action === 'new' || action === 'learning' || action === 'known') {
        await IR.vocab.mark(key, display, action);
        this._restyleWord(key, action);
        IR.toast(display + ' → ' + IR.vocab.statusText[action]);
        this._updateAfterMark();
        this._closePopup(popup);
      }
    });
  },

  _openPopup(span, popup) {
    const word = span.dataset.w;
    const key = span.dataset.k || word.toLowerCase();
    const entry = IR.vocab.cache.find(e => e.word === key);
    const status = entry ? entry.status : 'unknown';
    const statusLabel = IR.vocab.statusText[status] || '生词';
    popup.innerHTML = `
      <button class="wp-close" data-op="close">✕</button>
      <div class="wp-head">
        <span class="wp-word" style="color:${status === 'unknown' ? 'var(--w-unknown)' : status === 'learning' ? 'var(--w-learning)' : 'var(--text)'}">${IR.esc(word)}</span>
        <span class="wp-status">${statusLabel}${key !== word.toLowerCase() ? ' · ' + IR.esc(key) : ''}</span>
      </div>
      <div class="wp-phon">
        <button class="btn btn-sm wp-speak" data-op="speak" style="margin-right:.4rem">
          <svg class="speaker-icon" viewBox="0 0 13 11" xmlns="http://www.w3.org/2000/svg"><path d="M0 3.5h2L5 .8v9.4L2 7.5H0z" fill="currentColor"/><path d="M7 2.8a3 3 0 0 1 0 5.4M8.8 1.2a5 5 0 0 1 0 8.6" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>
          发音
        </button>
        <span>本地 TTS</span><span class="wp-phonetic" data-phon></span>
      </div>
      <div class="wp-meaning" data-res>${entry && entry.meaning ? IR.escLines(entry.meaning) : '<span class="wp-dict-note">离线词典未收录，正在自动翻译…</span>'}</div>
      <div class="wp-trans" data-trans hidden></div>
      <div class="wp-actions">
        <button class="btn btn-sm st-learning" data-op="learning" style="${status === 'learning' ? 'background:var(--w-learning);color:#fff' : ''}">标为在学</button>
        <button class="btn btn-sm st-known" data-op="known">标为已学</button>
        <button class="btn btn-sm st-new" data-op="new">＋ 生词本</button>
        <button class="btn btn-sm btn-ghost" data-op="trans">翻译</button>
        <button class="btn btn-sm btn-ghost" data-op="cam">剑桥 ↗</button>
      </div>`;
    popup.dataset.w = word;
    popup.dataset.k = key;
    popup.dataset.d = word;
    popup.hidden = false;
    const r = span.getBoundingClientRect();
    const pw = popup.offsetWidth, ph = popup.offsetHeight;
    let x = r.left + r.width / 2 - pw / 2;
    x = Math.max(8, Math.min(x, innerWidth - pw - 8));
    let y = r.bottom + 8;
    if (y + ph > innerHeight - 8) y = Math.max(8, r.top - ph - 8);
    popup.style.left = x + 'px';
    popup.style.top = y + 'px';
    if (IR.settings.data.tts.autoSpeak !== false) IR.tts.speak(word);

    /* M3：异步查询离线词典，查到后填充音标与释义（弹窗可能已关闭，需判空） */
    const phonEl = IR.$('[data-phon]', popup);
    const meanEl = IR.$('[data-res]', popup);
    if (phonEl || meanEl) {
      IR.dict.lookup(word).then(res => {
        if (popup.hidden) return;                       // 弹窗已关闭，放弃更新
        if (res) {
          if (phonEl && res.phonetic) phonEl.textContent = '/' + res.phonetic + '/';
          if (meanEl) {
            let html = '';
            if (res.pos) html += '<span class="pos">' + IR.esc(res.pos) + '</span>';
            html += IR.escLines(res.meaning);
            meanEl.innerHTML = html;
          }
        }
        /* 查不到：保留现有占位文案（自动翻译会接着填充译文） */
      }).catch(() => { /* 离线词典查询失败，静默降级 */ });
    }

    /* 自动翻译：点词即出译文（设置里可关）；带内存缓存，避免重复点同一词反复消耗额度 */
    this._autoTranslate(popup, word);
  },

  /* 在线翻译（内存缓存 300 条，超限整体清空） */
  _transCache: new Map(),
  async _translateWord(word) {
    const k = (word || '').toLowerCase();
    const hit = this._transCache.get(k);
    if (hit) return hit;
    const r = await IR.translate.run(word);
    if (this._transCache.size > 300) this._transCache.clear();
    this._transCache.set(k, r);
    return r;
  },
  async _autoTranslate(popup, word) {
    const cfg = IR.settings.data.reader || {};
    if (cfg.autoTranslate === false) return;
    const box = IR.$('[data-trans]', popup);
    if (!box) return;
    box.hidden = false;
    box.innerHTML = '<span class="wp-trans-note">翻译中…</span>';
    try {
      const r = await this._translateWord(word);
      if (popup.hidden || popup.dataset.w !== word) return;   /* 弹窗已关或已换词 */
      box.innerHTML = `<b>${IR.esc(r.engine)}</b>：` + IR.escLines(r.text);
    } catch (err) {
      if (popup.hidden || popup.dataset.w !== word) return;
      box.innerHTML = `<span class="wp-trans-note" style="color:var(--danger)">${IR.esc(err.message)}</span>`;
    }
  },

  _closePopup(popup) { popup.hidden = true; },

  /* ---------- 全文朗读 ---------- */
  speech: {
    state: 'idle', _token: 0,
    toggle() {
      if (this.state === 'idle') this.play();
      else if (this.state === 'playing') this.pause();
      else this.resume();
      this._syncBtn();
    },
    _syncBtn() {
      const b = IR.$('#btnSpeak');
      if (!b) return;
      b.textContent = this.state === 'playing' ? '⏸ 暂停' : this.state === 'paused' ? '▶ 继续朗读' : '▶ 朗读全文';
    },
    play() {
      if (!('speechSynthesis' in window)) return IR.toast('当前浏览器不支持语音合成', 'err');
      const R = IR.reader;
      const queue = [];
      R.blocks.forEach((blk, bi) => {
        if (blk.t === 'img' || !blk.text) return;
        blk.text.split(/(?<=[.!?…]["'”’)]*)\s+/).map(s => s.trim())
          .filter(s => /[A-Za-z\u4e00-\u9fff]/.test(s))
          .forEach(s => queue.push({ text: s, bi }));
      });
      if (!queue.length) return;
      this.state = 'playing';
      const token = ++this._token;
      const cfg = IR.settings.data.tts || {};
      const next = i => {
        if (token !== this._token || this.state !== 'playing') return;
        if (i >= queue.length) { this.stop(); return; }
        const { text, bi } = queue[i];
        R._ensureRendered(bi);
        R._highlightBlock(bi);
        const u = new SpeechSynthesisUtterance(text);
        const v = IR.tts.voices.find(x => x.voiceURI === (cfg.voiceURI || ''));
        if (v) u.voice = v;
        u.rate = cfg.rate || 0.9;
        u.lang = (v && v.lang) || 'en-US';
        u.onend = () => next(i + 1);
        u.onerror = () => next(i + 1);
        speechSynthesis.speak(u);
      };
      next(0);
    },
    pause() { this.state = 'paused'; try { speechSynthesis.pause(); } catch (e) { /* 忽略 */ } },
    resume() { this.state = 'playing'; try { speechSynthesis.resume(); } catch (e) { /* 忽略 */ } },
    stop() {
      this._token++; this.state = 'idle';
      try { speechSynthesis.cancel(); } catch (e) { /* 忽略 */ }
      IR.reader._clearHighlight();
      this._syncBtn();
    }
  },

  _highlightBlock(bi) {
    this._clearHighlight();
    const el = this.articleEl && this.articleEl.querySelector(`[data-bi="${bi}"]`);
    if (el) { el.classList.add('reading-active'); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  },
  _clearHighlight() { IR.$$('.reading-active').forEach(p => p.classList.remove('reading-active')); },

  /* ---------- 划词翻译 ---------- */
  bindSelection() {
    const btn = IR.$('#selTransBtn');
    let selText = '';
    document.addEventListener('mouseup', e => {
      if (e.target.closest('#selTransBtn') || e.target.closest('.word-popup')) return;
      setTimeout(() => {
        const sel = window.getSelection();
        const text = sel ? sel.toString().trim() : '';
        if (text.length > 1 && !IR.$('#readingView').hidden) {
          selText = text;
          try {
            const rect = sel.getRangeAt(0).getBoundingClientRect();
            btn.hidden = false;
            btn.style.left = Math.max(8, Math.min(innerWidth - 90, rect.left + rect.width / 2 - 40)) + 'px';
            btn.style.top = Math.max(8, rect.top - 44) + 'px';
          } catch (err) { btn.hidden = true; }
        } else btn.hidden = true;
      }, 10);
    });
    btn.addEventListener('click', async () => {
      btn.hidden = true;
      if (!selText) return;
      const popup = IR.$('#wordPopup');
      popup.innerHTML = `
        <button class="wp-close" data-op="close">✕</button>
        <div class="wp-head"><span class="wp-word" style="font-size:.98rem">“${IR.esc(selText.slice(0, 60))}${selText.length > 60 ? '…' : ''}”</span></div>
        <div class="wp-meaning" data-res>翻译中…</div>
        <div class="wp-actions">
          <button class="btn btn-sm btn-ghost" data-op="cam2">剑桥查首词 ↗</button>
          <button class="btn btn-sm btn-ghost" data-op="close">关闭</button>
        </div>`;
      popup.dataset.w = selText.split(/\s+/)[0] || '';
      popup.hidden = false;
      const r = btn.getBoundingClientRect();
      popup.style.left = Math.max(8, Math.min(innerWidth - 320, r.left - 130)) + 'px';
      popup.style.top = Math.max(8, r.bottom + 6) + 'px';
      const box = IR.$('[data-res]', popup);
      try {
        const res = await IR.translate.run(selText);
        box.innerHTML = IR.escLines(res.text) + `<span class="wp-dict-note" style="display:block;margin-top:.4rem">via ${res.engine}</span>`;
      } catch (err) {
        box.innerHTML = `<span style="color:var(--danger)">${IR.esc(err.message)}</span>`;
      }
    });
  },

  /* ---------- 本篇生词清单 ---------- */
  openWordList() {
    const R = this;
    const counts = new Map();
    for (const b of R.blocks) {
      if (b.t === 'img' || !b.text) continue;
      for (const seg of IR.tokenize(b.text)) {
        if (!IR.WORD_RE.test(seg)) continue;
        const { key, status } = R._wordStatus(seg);
        if (status !== 'unknown') continue;
        const e = counts.get(key) || { display: seg, count: 0 };
        e.count++;
        counts.set(key, e);
      }
    }
    const list = Array.from(counts.entries()).sort((a, b) => b[1].count - a[1].count);
    if (!list.length) return IR.toast('本文没有生词——全部都在你的词库里，太强了！', 'ok');
    const total = list.reduce((s, x) => s + x[1].count, 0);
    IR.modal.open(`
      <h3>本篇生词 ${list.length} 个（共出现 ${total.toLocaleString()} 次）<button class="btn btn-sm btn-ghost modal-close" data-x>✕ 关闭</button></h3>
      <div class="modal-body">
        <div class="settings-row" style="gap:.5rem">
          <button class="btn btn-sm" data-all="learning">全部标为在学</button>
          <button class="btn btn-sm" data-all="known">全部标为已学</button>
          <span class="settings-note" style="margin:0">按出现频次排序 · 标记后立即重新着色</span>
        </div>
        <div class="wordlist">
          ${list.slice(0, 300).map(([w, e]) => `
            <div class="wl-row" data-k="${IR.esc(w)}">
              <span class="wl-word">${IR.esc(e.display)}</span>
              <span class="wl-count">×${e.count}</span>
              <span class="v-ops">
                <button class="btn btn-sm st-learning" data-op="learning">在学</button>
                <button class="btn btn-sm st-known" data-op="known">已学</button>
              </span>
            </div>`).join('')}
        </div>
      </div>`, box => {
      box.addEventListener('click', async e => {
        if (e.target.closest('[data-x]')) { IR.modal.close(); return; }
        const all = e.target.closest('[data-all]');
        if (all) {
          const status = all.dataset.all;
          await IR.vocab.bulkMark(list.map(([w]) => w), status);
          for (const [w] of list) R._restyleWord(w, status);
          R._updateAfterMark();
          IR.modal.close();
          IR.toast(`已把 ${list.length} 个生词标为「${IR.vocab.statusText[status]}」`, 'ok');
          return;
        }
        const op = e.target.closest('[data-op]');
        if (!op) return;
        const key = op.closest('[data-k]').dataset.k;
        await IR.vocab.mark(key, undefined, op.dataset.op);
        R._restyleWord(key, op.dataset.op);
        op.closest('.wl-row').style.opacity = '.35';
        op.disabled = true;
        R._updateAfterMark();
      });
    });
  },

  bindM2() {
    IR.$('#btnSpeak').addEventListener('click', () => this.speech.toggle());
    IR.$('#btnWordList').addEventListener('click', () => this.openWordList());
    IR.$('#btnMode').addEventListener('click', () => this.toggleMode());
    IR.$('#tocFab').addEventListener('click', () => this.openToc());
    IR.$('#btnTocClose').addEventListener('click', () => this.closeToc());
    IR.$('#tocMask').addEventListener('click', () => this.closeToc());
    IR.$('#btnTocPin').addEventListener('click', () => this.pinToc());
    IR.$('#btnTocUnpin').addEventListener('click', () => this.unpinToc());
    this.bindSelection();
    this.bindPageNav();
    this.bindFont();
    this._applyFont();
    /* 滚动进度：内存即时更新 + 进度条刷新，落库节流（避免每次滚动写整本书） */
    window.addEventListener('scroll', IR.debounce(() => {
      if (!this.currentBook || IR.$('#readingView').hidden) return;
      if (this.mode === 'scroll') {
        const max = document.body.scrollHeight - innerHeight;
        this.currentBook.progress = max > 0 ? Math.min(1, scrollY / max) : 0;
        this._saveProgressSoon();
      }
      this._updateProgress();
    }, 120), { passive: true });
    /* 关闭 / 切后台时把阅读时长与进度落库 */
    window.addEventListener('pagehide', () => { this._flushRead(); this._stopReadTimer(); });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { this._flushRead(); }
      else if (this.currentBook && !IR.$('#readingView').hidden) { this._readStart = Date.now(); }
    });
    IR.$$('.nav-btn').forEach(b => b.addEventListener('click', () => {
      if (b.dataset.page !== 'reader') this.speech.stop();
    }));
  },

  /* ---------- 字体与排版 ---------- */
  _applyFont() {
    const r = IR.settings.data.reader || { fontSize: 18, lineHeight: 2.0, fontFamily: 'serif' };
    const root = document.documentElement;
    root.style.setProperty('--article-font-size', r.fontSize + 'px');
    root.style.setProperty('--article-line-height', r.lineHeight);
    const fam = r.fontFamily === 'sans' ? "'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif"
      : r.fontFamily === 'kai' ? "KaiTi,STKaiti,serif"
      : "Georgia,'Times New Roman',serif";
    root.style.setProperty('--article-font', fam);
  },
  bindFont() {
    const panel = IR.$('#fontPanel');
    const r = IR.settings.data.reader || { fontSize: 18, lineHeight: 2.0, fontFamily: 'serif' };
    IR.$('#btnFont').addEventListener('click', e => { e.stopPropagation(); panel.hidden = !panel.hidden; });
    document.addEventListener('click', e => {
      if (!panel.hidden && !e.target.closest('#fontPanel') && !e.target.closest('#btnFont')) panel.hidden = true;
    });
    IR.$('[data-fs-val]', panel).textContent = r.fontSize;
    IR.$$('[data-fs]', panel).forEach(b => b.addEventListener('click', () => {
      r.fontSize = Math.max(12, Math.min(30, r.fontSize + (+b.dataset.fs)));
      IR.$('[data-fs-val]', panel).textContent = r.fontSize;
      IR.settings.save();
      this._applyFont();
      if (this.mode === 'page') this._toPageMode();
    }));
    const lh = IR.$('[data-lh]', panel);
    lh.value = r.lineHeight;
    IR.$('[data-lh-val]', panel).textContent = (+r.lineHeight).toFixed(1);
    lh.addEventListener('input', () => {
      r.lineHeight = +lh.value;
      IR.$('[data-lh-val]', panel).textContent = (+lh.value).toFixed(1);
      IR.settings.save();
      this._applyFont();
      if (this.mode === 'page') this._toPageMode();
    });
    const ff = IR.$('[data-ff]', panel);
    ff.value = r.fontFamily;
    ff.addEventListener('change', () => {
      r.fontFamily = ff.value;
      IR.settings.save();
      this._applyFont();
      if (this.mode === 'page') this._toPageMode();
    });
  },

  /* ---------- 阅读进度 ---------- */
  _updateProgress() {
    let pct = 0;
    if (this.mode === 'page' && this.pageEls) {
      pct = this.pageEls.length > 1 ? this.pageIndex / (this.pageEls.length - 1) : 0;
    } else {
      const max = document.body.scrollHeight - innerHeight;
      pct = max > 0 ? Math.min(1, scrollY / max) : 0;
    }
    IR.$('#readingProgressBar').style.width = Math.round(pct * 100) + '%';
    IR.$('#readingProgressText').textContent = Math.round(pct * 100) + '%';
  }
};

/* ---------- TTS（本地语音） ---------- */
IR.tts = {
  voices: [],
  load() {
    if (!('speechSynthesis' in window)) return;
    const load = () => {
      this.voices = speechSynthesis.getVoices().filter(v => v.lang && v.lang.toLowerCase().startsWith('en'));
      document.dispatchEvent(new CustomEvent('ir:voices'));
    };
    load();
    speechSynthesis.onvoiceschanged = load;
  },
  speak(text) {
    if (!('speechSynthesis' in window)) return IR.toast('当前浏览器不支持语音合成', 'err');
    const cfg = IR.settings.data.tts || {};
    const u = new SpeechSynthesisUtterance(text);
    const v = this.voices.find(x => x.voiceURI === cfg.voiceURI);
    if (v) u.voice = v;
    u.rate = cfg.rate || 0.9;
    u.lang = (v && v.lang) || 'en-US';
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }
};
