/* 墨读 InkRead — 工具函数（DOM / 文本处理 / 提示） */
window.IR = window.IR || {};

/* ---------- DOM 快捷方式 ---------- */
IR.$ = (sel, root) => (root || document).querySelector(sel);
IR.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
IR.esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/* 多行文本 → HTML：先转义，再把「字面量 \n / \r\n」（词典数据里就是这样存的）
   与真实换行统一换成 <br>，避免界面上出现裸的 \n。 */
IR.escLines = s => IR.esc(s)
  .replace(/\\r\\n|\\n|\\r/g, '<br>')
  .replace(/\r\n|\r|\n/g, '<br>');
IR.el = (tag, attrs, html) => {
  const e = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    if (k === 'class') e.className = attrs[k];
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
    else e.setAttribute(k, attrs[k]);
  }
  if (html != null) e.innerHTML = html;
  return e;
};

/* ---------- Toast ---------- */
IR.toast = (msg, type) => {
  const box = IR.$('#toastBox');
  const t = IR.el('div', { class: 'toast' + (type ? ' ' + type : '') }, IR.esc(msg));
  box.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 2600);
  setTimeout(() => t.remove(), 3000);
};

/* ---------- 模态框 ---------- */
IR.modal = {
  open(html, onMount) {
    const mask = IR.$('#modalMask'), box = IR.$('#modalBox');
    box.innerHTML = html;
    mask.hidden = false;
    if (onMount) onMount(box);
  },
  close() { IR.$('#modalMask').hidden = true; IR.$('#modalBox').innerHTML = ''; }
};
document.addEventListener('click', e => {
  if (e.target.id === 'modalMask') IR.modal.close();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { IR.modal.close(); IR.popup && IR.popup.close(); }
});

/* ---------- 日期 ---------- */
IR.fmtDate = ts => {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/* ---------- 分词 ----------
   把一段文本切成 [文本, 单词, 文本, ...] 的序列，单词为连续英文字母（含撇号/连字符） */
IR.WORD_RE = /[A-Za-z][A-Za-z'’\-]*/;
IR.tokenize = text => text.split(new RegExp('(' + IR.WORD_RE.source + ')')).filter(s => s !== '');

/* ---------- 词形还原（启发式，M3 接入 ECDICT 词干库后升级） ----------
   返回候选词数组：原词在前，逐步剥离后缀的变体在后。
   阅读着色时按顺序在词库里查找第一个命中的候选。 */
const IRREG = {
  were:'be', was:'be', is:'be', are:'be', been:'be', being:'be', am:'be',
  has:'have', had:'have', having:'have',
  does:'do', did:'do', doing:'do', done:'do',
  says:'say', said:'say',
  children:'child', men:'man', women:'woman', people:'person',
  feet:'foot', teeth:'tooth', mice:'mouse', geese:'goose',
  better:'good', best:'good', worse:'bad', worst:'bad',
  further:'far', farther:'far', furthest:'far',
  wives:'wife', knives:'knife', lives:'life', leaves:'leaf',
  ourselves:'ourself', themselves:'themself'
};
IR.lemmas = word => {
  const w = word.toLowerCase();
  const out = [w];
  if (IRREG[w]) { out.push(IRREG[w]); return out; }
  if (w.length <= 3) return out;
  const vowel = c => /[aeiou]/.test(c);
  const push = s => { if (s.length >= 2 && !out.includes(s)) out.push(s); };
  /* 复数 / 三单 */
  if (w.endsWith('ies') && w.length > 4) push(w.slice(0, -3) + 'y');
  if (w.endsWith('ses') && w.length > 4) push(w.slice(0, -2));
  if (w.endsWith('es') && w.length > 4) push(w.slice(0, -2));
  if (w.endsWith('s') && !w.endsWith('ss')) push(w.slice(0, -1));
  /* 过去式 / 过去分词 */
  if (w.endsWith('ied') && w.length > 4) push(w.slice(0, -3) + 'y');
  if (w.endsWith('ed') && w.length > 4) {
    const stem = w.slice(0, -2);
    push(stem);
    if (stem.length > 2 && stem[stem.length-1] === stem[stem.length-2]) push(stem.slice(0, -1));  /* stopped → stop */
    push(w.slice(0, -1));  /* liked → like */
  }
  /* 进行时 */
  if (w.endsWith('ing') && w.length > 5) {
    const stem = w.slice(0, -3);
    push(stem);
    if (stem.length > 2 && stem[stem.length-1] === stem[stem.length-2]) push(stem.slice(0, -1));  /* running → run */
    if (vowel(stem[stem.length-1] || '')) push(stem + 'e');  /* making → make */
    push(w.slice(0, -3) + 'e');
  }
  /* 比较级 / 最高级 */
  if (w.endsWith('est') && w.length > 5) push(w.slice(0, -3));
  if (w.endsWith('er') && w.length > 4) push(w.slice(0, -2));
  return out;
};

/* ---------- 防抖 ---------- */
IR.debounce = (fn, ms) => {
  let t;
  return function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); };
};
