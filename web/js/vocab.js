/* 墨读 InkRead — 词库 / 生词本页面
   mount() 同时服务于「词库」和「生词本」两个入口（fixed 参数区分） */
window.IR = window.IR || {};

IR.vocab = {
  cache: [],            /* 全量词条 */
  statusMap: null,      /* word → status 的内存映射，阅读着色用 */
  statusText: { known: '已学', learning: '在学', new: '生词' },

  async reload() {
    this.cache = await IR.vocabStore.getAll();
    this.cache.sort((a, b) => b.updatedAt - a.updatedAt);
    this.statusMap = new Map(this.cache.map(e => [e.word, e.status]));
    document.dispatchEvent(new CustomEvent('ir:vocabchange'));
  },

  async mark(word, display, status, meaning) {
    const now = Date.now();
    const old = await IR.vocabStore.get(word);
    const entry = {
      word,
      display: display || (old && old.display) || word,
      meaning: meaning != null && meaning !== '' ? meaning : (old && old.meaning) || '',
      status, source: old && old.source || 'reader', updatedAt: now,
      addedAt: old && old.addedAt || now
    };
    await IR.vocabStore.put(entry);
    if (this.statusMap) this.statusMap.set(word, status);
    const i = this.cache.findIndex(e => e.word === word);
    if (i >= 0) this.cache[i] = entry; else this.cache.push(entry);
    document.dispatchEvent(new CustomEvent('ir:vocabchange'));
  },

  async removeWord(word) {
    await IR.vocabStore.remove(word);
    if (this.statusMap) this.statusMap.delete(word);
    this.cache = this.cache.filter(e => e.word !== word);
    document.dispatchEvent(new CustomEvent('ir:vocabchange'));
  },

  /* 释义回填：仅当词条存在且释义为空时写入（词典/翻译结果回存词表，不覆盖已有内容）。
     配合「点词即入生词本」：第二次点同一词直接从词表取中文，不再消耗翻译接口 */
  async fillMeaning(word, meaning) {
    const m = String(meaning || '').trim();
    if (!m) return;
    const old = this.cache.find(e => e.word === word);
    if (!old || (old.meaning && old.meaning.trim())) return;
    await this.mark(word, old.display, old.status, m);
  },

  /* 批量标记（M2）：一次事务写入 + 重建 statusMap */
  async bulkMark(words, status) {
    const now = Date.now();
    const byWord = new Map(this.cache.map(e => [e.word, e]));
    const entries = words.map(w => {
      const old = byWord.get(w);
      return old
        ? { ...old, status, updatedAt: now }
        : { word: w, display: w, meaning: '', status, source: '批量', addedAt: now, updatedAt: now };
    });
    await IR.vocabStore.bulkPut(entries);
    await this.reload();
  },

  /* 批量移除（M2） */
  async bulkRemove(words) {
    await Promise.all(words.map(w => IR.vocabStore.remove(w)));
    await this.reload();
  },

  /* ---------- 页面挂载（词库 / 生词本共用） ---------- */
  mount(mountEl, opts) {
    const fixed = (opts && opts.fixed) || null;   /* 生词本页固定 status='new' */
    const isStudy = fixed === 'new';
    mountEl.innerHTML = `
      <div class="vocab-toolbar">
        ${isStudy ? '' : '<button class="btn btn-primary" data-act="import">导入词表</button>'}
        ${isStudy ? '' : '<button class="btn btn-ghost" data-act="export-xlsx">导出词表</button>'}
        <button class="btn btn-ghost" data-act="export">导出备份</button>
        <div class="vocab-tabs" data-role="tabs"></div>
        <input class="input vocab-search" data-role="search" placeholder="搜索单词…">
      </div>
      <div class="vocab-meta" data-role="meta"></div>
      <div class="batch-bar" data-role="batch" hidden>
        <span>已选 <b data-role="selcount">0</b> 个</span>
        <button class="btn btn-sm st-learning" data-bulk="learning">标为在学</button>
        <button class="btn btn-sm st-known" data-bulk="known">标为已学</button>
        <button class="btn btn-sm btn-danger" data-bulk="del">移除所选</button>
        <button class="btn btn-sm btn-ghost" data-bulk="clear">取消选择</button>
      </div>
      <div class="vocab-table">
        <div class="vrow vhead"><span class="v-chk"></span><span>单词</span><span>释义</span><span>状态</span><span>来源</span><span>操作</span></div>
        <div data-role="rows"></div>
      </div>`;
    const st = {
      mountEl, fixed, filter: fixed || 'all', query: '', selected: new Set(),
      rowsEl: IR.$('[data-role="rows"]', mountEl),
      metaEl: IR.$('[data-role="meta"]', mountEl),
      tabsEl: IR.$('[data-role="tabs"]', mountEl),
      searchEl: IR.$('[data-role="search"]', mountEl),
      batchEl: IR.$('[data-role="batch"]', mountEl),
      rendered: 0, filtered: []
    };
    mountEl._state = st;

    if (!fixed) {
      st.tabsEl.innerHTML = ['all', 'known', 'learning', 'new'].map(f =>
        `<button class="chip chip-btn${f === 'all' ? ' active' : ''}" data-f="${f}">${{ all: '全部', known: '已学', learning: '在学', new: '生词本' }[f]}</button>`).join('');
      st.tabsEl.addEventListener('click', e => {
        const b = e.target.closest('[data-f]');
        if (!b) return;
        st.filter = b.dataset.f;
        IR.$$('.chip', st.tabsEl).forEach(c => c.classList.toggle('active', c === b));
        this.renderList(st);
      });
    } else {
      st.tabsEl.innerHTML = '<span class="chip active">生词本</span>';
    }
    st.searchEl.addEventListener('input', IR.debounce(() => { st.query = st.searchEl.value.trim().toLowerCase(); this.renderList(st); }, 150));
    mountEl.addEventListener('click', e => {
      const act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.dataset.act === 'import') this.openImportModal();
      if (act.dataset.act === 'export') IR.exportBackup();
      if (act.dataset.act === 'export-xlsx') IR.exportVocabExcel();
    });
    /* 行内操作（状态按钮 / 删除 / 复选框） */
    st.rowsEl.addEventListener('click', async e => {
      const btn = e.target.closest('[data-op]');
      if (!btn) return;
      const word = btn.closest('[data-w]').dataset.w;
      if (btn.dataset.op === 'del') {
        await this.removeWord(word);
        st.selected.delete(word);
        IR.toast('已移除 ' + word);
      } else {
        await this.mark(word, undefined, btn.dataset.op);
        IR.toast(word + ' → ' + this.statusText[btn.dataset.op]);
      }
      this.renderList(st);
    });
    st.rowsEl.addEventListener('change', e => {
      const chk = e.target.closest('[data-check]');
      if (!chk) return;
      const word = chk.closest('[data-w]').dataset.w;
      if (chk.checked) st.selected.add(word); else st.selected.delete(word);
      chk.closest('[data-w]').classList.toggle('row-selected', chk.checked);
      this._syncBatch(st);
    });
    /* 批量操作条 */
    st.batchEl.addEventListener('click', async e => {
      const b = e.target.closest('[data-bulk]');
      if (!b) return;
      const words = [...st.selected];
      if (b.dataset.bulk !== 'clear' && !words.length) return;
      if (b.dataset.bulk === 'clear') {
        st.selected.clear();
      } else if (b.dataset.bulk === 'del') {
        if (!confirm(`移除所选 ${words.length} 个单词？`)) return;
        await this.bulkRemove(words);
        IR.toast(`已移除 ${words.length} 个`, 'ok');
        st.selected.clear();
      } else {
        await this.bulkMark(words, b.dataset.bulk);
        IR.toast(`已把 ${words.length} 个标为「${this.statusText[b.dataset.bulk]}」`, 'ok');
        st.selected.clear();
      }
      this.renderList(st);
    });
    /* 无限滚动 */
    const io = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && st.rendered < st.filtered.length) this._appendRows(st);
    }, { rootMargin: '400px' });
    const sentinel = IR.el('div', { class: 'pager-hint' });
    st.rowsEl.parentNode.appendChild(sentinel);
    io.observe(sentinel);
    this.renderList(st);
  },

  renderList(st) {
    st.filtered = this.cache.filter(e =>
      (st.filter === 'all' || e.status === st.filter) &&
      (!st.query || e.word.includes(st.query)));
    st.rendered = 0;
    st.rowsEl.innerHTML = '';
    const counts = { all: this.cache.length, known: 0, learning: 0, new: 0 };
    for (const e of this.cache) if (counts[e.status] != null) counts[e.status]++;
    st.metaEl.textContent = isStudyText(st)
      ? `生词本 ${counts.new} 词 · 阅读时点击「＋ 生词本」收集`
      : `词库 ${counts.all} 词 · 已学 ${counts.known} · 在学 ${counts.learning} · 生词本 ${counts.new}`;
    if (!st.filtered.length) {
      st.rowsEl.innerHTML = `<div class="vocab-empty">${st.query ? '没有匹配的单词' : (st.fixed ? '生词本还是空的——阅读时点开单词，按「＋ 生词本」收集' : '词库还是空的，点右上角「导入词表」开始')}</div>`;
    } else {
      this._appendRows(st);
    }
    function isStudyText(s) { return !!s.fixed; }
  },

  _syncBatch(st) {
    IR.$('[data-role="selcount"]', st.batchEl).textContent = st.selected.size;
    st.batchEl.hidden = st.selected.size === 0;
  },

  _appendRows(st) {
    const CH = 150;
    const frag = document.createDocumentFragment();
    const end = Math.min(st.rendered + CH, st.filtered.length);
    for (let i = st.rendered; i < end; i++) {
      const e = st.filtered[i];
      const row = IR.el('div', { class: 'vrow' + (st.selected.has(e.word) ? ' row-selected' : ''), 'data-w': e.word });
      row.innerHTML = `
        <span class="v-chk"><input type="checkbox" data-check ${st.selected.has(e.word) ? 'checked' : ''}></span>
        <span class="v-word">${IR.esc(e.display || e.word)}</span>
        <span class="v-meaning" title="${IR.escLines(e.meaning || '')}">${IR.escLines(e.meaning || '—')}</span>
        <span class="chip st-${e.status}">${this.statusText[e.status] || e.status}</span>
        <span class="v-src">${IR.esc(e.source || '')}</span>
        <span class="v-ops">
          <button class="btn btn-sm st-learning" data-op="learning" title="标为在学">在学</button>
          <button class="btn btn-sm st-known" data-op="known" title="标为已学">已学</button>
          <button class="btn btn-sm btn-danger icon-only" data-op="del" title="移除">✕</button>
        </span>`;
      frag.appendChild(row);
    }
    st.rendered = end;
    st.rowsEl.appendChild(frag);
    this._syncBatch(st);
  },

  /* ---------- 导入词表弹窗 ---------- */
  openImportModal() {
    IR.modal.open(`
      <h3>导入词表 <button class="btn btn-sm btn-ghost modal-close" data-x>✕ 关闭</button></h3>
      <div class="modal-body">
        <div class="import-tabs">
          <button class="chip chip-btn active" data-tab="file">文件导入</button>
          <button class="chip chip-btn" data-tab="paste">粘贴导入</button>
        </div>
        <div data-pane="file">
          <label class="file-label">
            点击选择 TXT / CSV / Excel 文件<br>
            <span style="font-size:.78rem;color:var(--text-3)">每行一个单词，或「单词 + 释义」（空格 / 逗号 / Tab 分隔均可）</span>
            <input type="file" accept=".txt,.csv,.tsv,.xlsx,.xls" hidden data-file>
          </label>
        </div>
        <div data-pane="paste" hidden>
          <textarea class="input import-area" data-paste placeholder="每行一个单词或「单词 释义」&#10;# 开头的行会被忽略"></textarea>
        </div>
        <div class="settings-row">
          <label>导入后标记为</label>
          <select class="input" data-status style="width:130px">
            <option value="known">已学</option>
            <option value="learning">在学</option>
          </select>
        </div>
        <label class="settings-row" style="gap:.4rem">
          <input type="checkbox" data-overwrite>
          <span style="color:var(--text-2);font-size:.88rem">已存在的单词：覆盖其标记状态（默认仅补充释义）</span>
        </label>
        <div class="import-summary" data-summary>等待导入…</div>
        <div class="modal-foot">
          <button class="btn btn-ghost" data-x>取消</button>
          <button class="btn btn-primary" data-go disabled>确认导入</button>
        </div>
      </div>`, box => {
      let parsed = [];
      const summary = IR.$('[data-summary]', box);
      const goBtn = IR.$('[data-go]', box);
      const statusSel = IR.$('[data-status]', box);
      const overwrite = IR.$('[data-overwrite]', box);
      const setSummary = () => {
        if (!parsed.length) { summary.innerHTML = '等待导入…'; goBtn.disabled = true; return; }
        const known = new Set(IR.vocab.cache.map(e => e.word));
        const dup = parsed.filter(p => known.has(p.word)).length;
        summary.innerHTML = `解析到 <b>${parsed.length}</b> 个单词` + (dup ? `，其中 <b>${dup}</b> 个已在词库` : '') + `，将标记为「<b>${statusSel.value === 'known' ? '已学' : '在学'}</b>」`;
        goBtn.disabled = false;
      };
      statusSel.addEventListener('change', setSummary);
      box.addEventListener('click', e => {
        if (e.target.closest('[data-x]')) { IR.modal.close(); return; }
        const tab = e.target.closest('[data-tab]');
        if (tab) {
          IR.$$('[data-tab]', box).forEach(t => t.classList.toggle('active', t === tab));
          IR.$('[data-pane="file"]', box).hidden = tab.dataset.tab !== 'file';
          IR.$('[data-pane="paste"]', box).hidden = tab.dataset.tab !== 'paste';
          return;
        }
        if (e.target.closest('[data-go]')) this._doImport(parsed, statusSel.value, overwrite.checked);
      });
      IR.$('[data-file]', box).addEventListener('change', async e => {
        const f = e.target.files[0];
        if (!f) return;
        try {
          if (/\.(xlsx|xls)$/i.test(f.name)) {
            const wb = XLSX.read(await f.arrayBuffer());
            const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
            parsed = rows.map(r => (r[0] + '')).join('\n') ? IR.importers.parseVocabLines(rows.map(r => [r[0], r[1]].filter(x => x != null && x !== '').join('\t')).join('\n')) : [];
          } else {
            const text = new TextDecoder(IR.importers.detectEncoding(new Uint8Array(await f.arrayBuffer()))).decode(await f.arrayBuffer());
            parsed = IR.importers.parseVocabLines(text);
          }
          setSummary();
        } catch (err) { IR.toast('解析失败：' + err.message, 'err'); }
      });
      IR.$('[data-paste]', box).addEventListener('input', IR.debounce(e => {
        parsed = IR.importers.parseVocabLines(e.target.value);
        setSummary();
      }, 200));
    });
  },

  async _doImport(parsed, status, overwrite) {
    if (!parsed.length) return;
    const now = Date.now();
    const existing = new Map(IR.vocab.cache.map(e => [e.word, e]));
    let added = 0, merged = 0;
    const batch = parsed.map(p => {
      const old = existing.get(p.word);
      if (old) {
        merged++;
        return {
          ...old,
          meaning: p.meaning || old.meaning,
          status: overwrite ? status : old.status,
          updatedAt: now
        };
      }
      added++;
      return { word: p.word, display: p.display, meaning: p.meaning, status, source: '导入', addedAt: now, updatedAt: now };
    });
    await IR.vocabStore.bulkPut(batch);
    await this.reload();
    IR.modal.close();
    IR.toast(`导入完成：新增 ${added}，合并 ${merged}`, 'ok');
    document.dispatchEvent(new CustomEvent('ir:vocabimport'));
  }
};

/* ---------- 全量备份（词库 + 设置 + 翻译接口配置） ---------- */
IR.exportBackup = () => {
  const data = {
    app: 'inkread', version: 2, kind: 'full', exportedAt: new Date().toISOString(),
    settings: IR.settings.data, vocab: IR.vocab.cache
  };
  IR.downloadJson(data, 'inkread-backup-' + IR.fmtDate(Date.now()) + '.json');
  IR.toast('备份已导出（含设置与接口配置）', 'ok');
};

/* ---------- 仅配置（设置 + 翻译接口 Key）：换端只需替换这个文件 ---------- */
IR.exportConfig = () => {
  const data = {
    app: 'inkread', version: 2, kind: 'config', exportedAt: new Date().toISOString(),
    settings: IR.settings.data
  };
  IR.downloadJson(data, 'inkread-config-' + IR.fmtDate(Date.now()) + '.json');
  IR.toast('配置已导出（含 API Key 与所有设置）', 'ok');
};

IR.downloadJson = (obj, filename) => {
  const blob = new Blob([JSON.stringify(obj, null, 1)], { type: 'application/json' });
  const a = IR.el('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
};

/* 把恢复出来的 settings 合并进当前设置（逐家深合并 API 配置） */
IR.mergeSettings = saved => {
  const merged = {
    ...IR.settings.data, ...saved,
    tts: { ...IR.settings.data.tts, ...(saved.tts || {}) },
    reader: { ...IR.settings.data.reader, ...(saved.reader || {}) }
  };
  const api = { ...IR.settings.data.api };
  const savedApi = saved.api || {};
  for (const k in savedApi) {
    const cur = api[k], val = savedApi[k];
    api[k] = (cur && typeof cur === 'object' && !Array.isArray(cur) && val && typeof val === 'object')
      ? { ...cur, ...val } : val;
  }
  merged.api = api;
  IR.settings.data = merged;
  IR.settings.save();
};

/* 恢复后重载页面：保证主题 / 字体 / 接口配置全部生效 */
IR.reloadAfterRestore = msg => {
  IR.toast(msg + '，正在刷新…', 'ok');
  setTimeout(() => location.reload(), 700);
};

/* 导入“仅配置”文件：换端只需这一步 */
IR.importConfig = file => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => {
    try {
      const data = JSON.parse(fr.result);
      if (data.app !== 'inkread' || !data.settings) throw new Error('不是墨读的配置文件');
      IR.mergeSettings(data.settings);
      IR.reloadAfterRestore('配置已恢复');
      resolve();
    } catch (e) { IR.toast('配置恢复失败：' + e.message, 'err'); reject(e); }
  };
  fr.onerror = () => reject(fr.error);
  fr.readAsText(file);
});

/* 导出词表为 Excel（.xlsx，Excel / WPS 均可打开） */
IR.exportVocabExcel = () => {
  if (typeof XLSX === 'undefined') return IR.toast('Excel 组件未加载，请通过本地服务器打开', 'err');
  const rows = [['单词', '释义', '状态', '来源']];
  for (const e of IR.vocab.cache) {
    rows.push([e.display || e.word, e.meaning || '', IR.vocab.statusText[e.status] || e.status, e.source || '']);
  }
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 18 }, { wch: 40 }, { wch: 10 }, { wch: 14 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '词库');
  XLSX.writeFile(wb, 'inkread-词库-' + IR.fmtDate(Date.now()) + '.xlsx');
  IR.toast('已导出 ' + IR.vocab.cache.length + ' 个单词', 'ok');
};

IR.importBackup = file => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = async () => {
    try {
      const data = JSON.parse(fr.result);
      if (data.app !== 'inkread') throw new Error('不是墨读的备份文件');
      if (Array.isArray(data.vocab)) {
        await IR.vocabStore.clear();
        await IR.vocabStore.bulkPut(data.vocab);
        await IR.vocab.reload();
      }
      const n = Array.isArray(data.vocab) ? data.vocab.length : 0;
      if (data.settings) {
        IR.mergeSettings(data.settings);           /* 设置 + 翻译接口配置一并恢复 */
        IR.reloadAfterRestore(`恢复完成：${n} 个单词 + 全部设置`);
        resolve();
        return;
      }
      IR.toast(`恢复完成：${n} 个单词`, 'ok');
      resolve();
    } catch (e) { IR.toast('恢复失败：' + e.message, 'err'); reject(e); }
  };
  fr.onerror = () => reject(fr.error);
  fr.readAsText(file);
});
