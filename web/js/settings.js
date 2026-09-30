/* 墨读 InkRead — 设置页：主题 / 标注颜色 / TTS / 翻译接口 / 数据 */
window.IR = window.IR || {};

IR.settingsPage = {
  mount(mountEl) {
    const s = IR.settings.data;
    const cs = s.colors || {};
    const px = s.api.proxy || {};
    const curCol = k => cs[k] || getComputedStyle(document.documentElement).getPropertyValue('--w-' + k).trim();

    /* 各引擎必填项判断（用于状态徽标） */
    const filled = {
      youdao: c => !!(c.secret && (c.key || c.apiKeys)),
      tencent: c => !!(c.secretId && c.secretKey),
      aliyun: c => !!c.apiKey,
      alimt: c => !!(c.accessKeyId && c.accessKeySecret),
      volcano: c => !!c.apiKey,
      volmt: c => !!(c.accessKeyId && c.accessKeySecret),
      deepl: c => !!c.apiKey,
      ms: c => !!c.apiKey,
      libre: c => !!(c.url || c.apiKey),
      mymemory: () => true, google: () => true, bing: () => true,
      proxy: c => !!(c.on && c.url)
    };

    /* 生成一张可折叠接口卡片：fields = [标签, 字段名, 占位符?, 是否密码?]；link = [文案, 网址]；extra = 额外 HTML（如下拉）
       徽标三态：未配置（灰）/ 已配置+测试通过（绿 ✓）/ 已配置+测试未通过（红 ✗）/ 已配置未测试（灰）
       展开规则：已配置自动展开；但用户手动收起过（_collapsed）就不再自动展开 */
    const card = (name, title, fields, hint, link, extra) => {
      const cfg = s.api[name] || {};
      const ok = filled[name](cfg);
      const tested = cfg._testOk;                 /* undefined=未测试 true=通过 false=未通过 */
      const openAttr = (ok && !cfg._collapsed) ? ' open' : '';
      const badgeHtml = !ok
        ? `<span class="api-badge" data-badge="${name}">未配置</span>`
        : tested === true
          ? `<span class="api-badge ok" data-badge="${name}">已配置 ✓</span>`
          : tested === false
            ? `<span class="api-badge bad" data-badge="${name}">已配置 ✗</span>`
            : `<span class="api-badge" data-badge="${name}">已配置</span>`;
      const statusText = !ok ? '未配置'
        : tested === true ? '已配置 · 上次测试通过 ✓'
        : tested === false ? '已配置 · 上次测试未通过 ✗'
        : '已配置 · 未测试';
      const field = f => {
        const attrs = `data-api-in="${name}.${f[1]}" value="${IR.esc((s.api[name] && s.api[name][f[1]]) || '')}" placeholder="${IR.esc(f[2] || '')}"`;
        /* 密码框：加「显示/隐藏」切换按钮 */
        return f[3]
          ? `<div class="settings-row"><label>${f[0]}</label><div class="pw-box">` +
            `<input class="input" type="password" ${attrs}>` +
            `<button type="button" class="btn btn-sm pw-eye" data-pw-eye tabindex="-1" title="显示或隐藏密文">显示</button></div></div>`
          : `<div class="settings-row"><label>${f[0]}</label><input class="input" ${attrs}></div>`;
      };
      return `
        <details class="api-card" data-card="${name}"${openAttr}>
          <summary>
            <h4>${title}</h4>
            ${badgeHtml}
          </summary>
          <div class="api-card-body">
            ${link ? `<a class="api-get" href="${link[1]}" target="_blank" rel="noopener">去获取 ${link[0]} ↗</a>` : ''}
            ${(fields || []).map(field).join('')}
            ${extra || ''}
            <div class="api-card-foot">
              <button class="btn btn-sm btn-primary" data-api-save="${name}">保存</button>
              <button class="btn btn-sm" data-api-test="${name}">测试</button>
              ${hint ? `<span class="api-hint">${hint}</span>` : ''}
            </div>
            <div class="api-status" data-api-status="${name}">${statusText}</div>
          </div>
        </details>`;
    };

    mountEl.innerHTML = `
      <div class="panel settings-section">
        <h3>主题</h3>
        <div class="theme-cards" data-role="themes"></div>
        <p class="settings-note">5 套主题随时切换，所有界面（阅读器 / 词库 / 弹窗）同步生效。</p>
      </div>
      <div class="panel settings-section">
        <h3>单词标注三色</h3>
        <div class="settings-row"><label>生词（不会）</label><input type="color" class="input" data-color="unknown" value="${curCol('unknown')}"><span class="settings-note" style="margin:0">词库里没有的词</span></div>
        <div class="settings-row"><label>在学</label><input type="color" class="input" data-color="learning" value="${curCol('learning')}"><span class="settings-note" style="margin:0">标记为「在学」的词</span></div>
        <div class="settings-row"><label>已学</label><input type="color" class="input" data-color="known" value="${curCol('known')}"><span class="settings-note" style="margin:0">标记为「已学」的词</span></div>
        <div class="settings-row"><button class="btn btn-ghost" data-reset-colors>恢复主题默认色</button></div>
        <p class="settings-note">自定义颜色优先于主题默认色，对所有主题生效。</p>
      </div>
      <div class="panel settings-section">
        <h3>发音（本地 TTS）</h3>
        <div class="settings-row"><label>音色</label><select class="input" data-tts-voice style="min-width:260px"></select></div>
        <div class="settings-row"><label>语速</label><input type="range" min="0.5" max="1.5" step="0.05" value="${(s.tts && s.tts.rate) || 0.9}" data-tts-rate style="width:180px"><span data-tts-rate-val>${(s.tts && s.tts.rate) || 0.9}x</span></div>
        <div class="settings-row"><label>点词自动发音</label><label class="switch"><input type="checkbox" data-tts-auto ${(s.tts && s.tts.autoSpeak !== false) ? 'checked' : ''}><span class="switch-track"></span></label></div>
        <div class="settings-row"><button class="btn" data-tts-test>试听：trepidation</button></div>
        <p class="settings-note">调用 Windows 本地语音（微软 David / Zira 等）。列表为空时，先在系统「设置 → 时间和语言 → 语音」添加英语语音包。</p>
      </div>

      <div class="panel settings-section">
        <h3>翻译接口</h3>

        <div class="api-toolbar">
          <div class="settings-row">
            <label>默认引擎</label>
            <select class="input" data-engine style="width:250px">
              <option value="auto" ${!s.api.engine || s.api.engine === 'auto' ? 'selected' : ''}>自动（已配置的优先 → 免费兜底）</option>
              <optgroup label="官方接口（需 Key）">
                <option value="youdao" ${s.api.engine === 'youdao' ? 'selected' : ''}>有道智云</option>
                <option value="tencent" ${s.api.engine === 'tencent' ? 'selected' : ''}>腾讯云 TMT</option>
                <option value="aliyun" ${s.api.engine === 'aliyun' ? 'selected' : ''}>阿里云百炼</option>
                <option value="alimt" ${s.api.engine === 'alimt' ? 'selected' : ''}>阿里云机器翻译</option>
                <option value="volcano" ${s.api.engine === 'volcano' ? 'selected' : ''}>火山方舟 · 豆包</option>
                <option value="volmt" ${s.api.engine === 'volmt' ? 'selected' : ''}>火山机器翻译</option>
                <option value="deepl" ${s.api.engine === 'deepl' ? 'selected' : ''}>DeepL</option>
                <option value="ms" ${s.api.engine === 'ms' ? 'selected' : ''}>微软翻译（Azure）</option>
              </optgroup>
              <optgroup label="开源 / 自建">
                <option value="libre" ${s.api.engine === 'libre' ? 'selected' : ''}>LibreTranslate</option>
              </optgroup>
              <optgroup label="免费内置（无需 Key）">
                <option value="mymemory" ${s.api.engine === 'mymemory' ? 'selected' : ''}>MyMemory（国内直连）</option>
                <option value="google" ${s.api.engine === 'google' ? 'selected' : ''}>谷歌翻译</option>
                <option value="bing" ${s.api.engine === 'bing' ? 'selected' : ''}>必应翻译</option>
              </optgroup>
            </select>
            <span class="settings-note" style="margin:0">划词 / 点词句子翻译用；单词释义优先走内置词典</span>
          </div>
          <div class="settings-row">
            <label>点词自动翻译</label>
            <label class="switch"><input type="checkbox" data-auto-trans ${(s.reader && s.reader.autoTranslate === false) ? '' : 'checked'}><span class="switch-track"></span></label>
            <span class="settings-note" style="margin:0">点单词弹窗后自动出译文，无需再点「翻译」</span>
          </div>
          <details class="api-help" data-order-box>
            <summary>自动模式尝试顺序（点开调整；腾讯默认垫底）</summary>
            <div class="auto-order-list" data-order-list></div>
            <div class="api-card-foot" style="margin-top:.4rem">
              <button class="btn btn-sm" data-order-reset>恢复默认顺序</button>
              <span class="api-hint">只影响「自动」引擎：按此顺序试已配置的接口，都失败才用 MyMemory 兜底</span>
            </div>
          </details>
          <div class="api-status" data-localproxy>本地转发：检测中…</div>
        </div>

        <div class="api-group">
          <div class="api-group-title">国内云厂商 · 官方接口</div>
          <div class="api-grid">
            ${card('youdao', '有道智云', [
              ['应用ID', 'key', '官网「应用ID」'],
              ['API Keys', 'apiKeys', '官网「查看」获取；选填，鉴权失败自动重试'],
              ['应用密钥', 'secret', '官网「应用密钥」', true]
            ], '官方三字段', ['有道智云控制台', 'https://ai.youdao.com/'])}
            ${card('tencent', '腾讯云 TMT', [
              ['SecretId', 'secretId', '访问管理 → API 密钥'],
              ['SecretKey', 'secretKey', '访问管理 → API 密钥', true],
              ['地域', 'region', '默认 ap-guangzhou']
            ], '无 API Key 方案，只能用密钥', ['腾讯云 API 密钥', 'https://console.cloud.tencent.com/cam/capi'])}
            ${card('aliyun', '阿里云百炼（API Key）', [
              ['API Key', 'apiKey', 'bailian.console.aliyun.com → API-KEY（sk-…）', true],
              ['模型', 'model', '留空用 qwen-plus；可填 qwen-turbo 等']
            ], '只要一个 API Key', ['百炼 API-KEY 页面', 'https://bailian.console.aliyun.com/'])}
            ${card('alimt', '阿里云机器翻译（AccessKey）', [
              ['AccessKeyId', 'accessKeyId', 'LTAI 开头；RAM 子账号建议只授权机器翻译', true],
              ['AccessKeySecret', 'accessKeySecret', '与 AccessKeyId 成对使用', true]
            ], '通用版全领域；专业版垂类更准（需分别开通）', ['机器翻译控制台', 'https://mt.console.aliyun.com/'], `
              <div class="settings-row"><label>版本</label>
                <select class="input" data-api-in="alimt.edition" style="width:200px">
                  <option value="general" ${((s.api.alimt || {}).edition || 'general') === 'general' ? 'selected' : ''}>通用版（全领域）</option>
                  <option value="pro" ${(s.api.alimt || {}).edition === 'pro' ? 'selected' : ''}>专业版（垂类）</option>
                </select>
                <span class="settings-note" style="margin:0">专业版需另开通</span></div>
              <div class="settings-row"><label>场景（专业版）</label>
                <select class="input" data-api-in="alimt.scene" style="width:200px">
                  <option value="social" ${((s.api.alimt || {}).scene || 'social') === 'social' ? 'selected' : ''}>社交（口语化，默认）</option>
                  <option value="description" ${(s.api.alimt || {}).scene === 'description' ? 'selected' : ''}>商品描述</option>
                  <option value="title" ${(s.api.alimt || {}).scene === 'title' ? 'selected' : ''}>商品标题</option>
                  <option value="communication" ${(s.api.alimt || {}).scene === 'communication' ? 'selected' : ''}>商品沟通</option>
                  <option value="medical" ${(s.api.alimt || {}).scene === 'medical' ? 'selected' : ''}>医疗</option>
                  <option value="finance" ${(s.api.alimt || {}).scene === 'finance' ? 'selected' : ''}>金融</option>
                </select></div>`)}
            ${card('volcano', '火山方舟 · 豆包（API Key）', [
              ['API Key', 'apiKey', '形如 ark-xxxx…；console.volcengine.com/ark → API Key 管理', true],
              ['模型', 'model', '留空用 doubao-seed-translation；也可填 ep-… 等其他已开通模型']
            ], '只要一个 API Key（默认走豆包翻译模型，英文 → 中文）', ['火山方舟 API Key', 'https://console.volcengine.com/ark'])}
            ${card('volmt', '火山机器翻译（AccessKey）', [
              ['AccessKey', 'accessKeyId', '控制台右上角头像 → 访问密钥；建议 IAM 子账号', true],
              ['SecretKey', 'accessKeySecret', '与 AccessKey 成对使用', true]
            ], '需先在控制台开通机器翻译服务（非大模型，经典机翻）', ['火山控制台', 'https://console.volcengine.com/'])}
            ${card('deepl', 'DeepL（API Free / Pro）', [
              ['API Key', 'apiKey', '免费版 Key 以 :fx 结尾；自动选 api-free / api', true]
            ], '只要一个 API Key', ['DeepL 账户 → API 密钥', 'https://www.deepl.com/your-account/keys'])}
            ${card('ms', '微软翻译（Azure）', [
              ['API Key', 'apiKey', 'Azure 翻译资源 → 密钥和终结点 → KEY 1', true],
              ['区域', 'region', '多服务/区域资源必填，如 eastasia；全局资源可空']
            ], '只要一个 API Key（+区域）', ['Azure 翻译服务', 'https://portal.azure.com/'])}
          </div>
        </div>

        <div class="api-group">
          <div class="api-group-title">开源 / 自建</div>
          <div class="api-grid">
            ${card('libre', 'LibreTranslate', [
              ['服务地址', 'url', '留空用 libretranslate.com；自建可填 http://localhost:5000'],
              ['API Key', 'apiKey', '自建实例通常留空；公开实例多数需要', true]
            ], '可自建、可离线部署', ['LibreTranslate 官网', 'https://libretranslate.com/'])}
          </div>
        </div>

        <div class="api-group">
          <div class="api-group-title">免费内置 · 无需 Key</div>
          <div class="api-grid">
            <details class="api-card" data-card="free">
              <summary><h4>免费引擎</h4><span class="api-badge ok">内置可用</span></summary>
              <div class="api-card-body">
                <div class="api-card-foot">
                  <button class="btn btn-sm" data-api-test="mymemory">测试 MyMemory</button>
                  <button class="btn btn-sm" data-api-test="google">测试谷歌</button>
                  <button class="btn btn-sm" data-api-test="bing">测试必应</button>
                </div>
                <div class="api-status" data-api-status="mymemory">MyMemory · 国内直连，开箱即用</div>
                <div class="api-status" data-api-status="google">谷歌 · 大陆网络通常不通，需代理</div>
                <div class="api-status" data-api-status="bing">必应 · 令牌接口有地区限制，需海外网络</div>
              </div>
            </details>
          </div>
        </div>

        <div class="api-group">
          <div class="api-group-title">网络</div>
          <div class="api-grid">
            <details class="api-card" data-card="proxy"${px.on && px.url ? ' open' : ''}>
              <summary>
                <h4>代理访问（谷歌 / 必应等）</h4>
                <span class="api-badge${px.on && px.url ? ' ok' : ''}" data-badge="proxy">${px.on && px.url ? '已启用' : '未启用'}</span>
              </summary>
              <div class="api-card-body">
                <div class="settings-row"><label>启用代理</label><label class="switch"><input type="checkbox" data-proxy-on ${px.on ? 'checked' : ''}><span class="switch-track"></span></label></div>
                <div class="settings-row"><label>代理地址</label><input class="input" data-proxy-url value="${IR.esc(px.url)}" placeholder="http://127.0.0.1:7890"></div>
                <div class="api-card-foot">
                  <button class="btn btn-sm btn-primary" data-proxy-save>保存</button>
                  <button class="btn btn-sm" data-proxy-test>测试谷歌</button>
                </div>
                <div class="api-status" data-proxy-status>${px.on && px.url ? '已启用 · ' + IR.esc(px.url) : '未启用'}</div>
              </div>
            </details>
          </div>
        </div>

        <details class="api-help">
          <summary>怎么申请 Key / 哪些是必填（点开看）</summary>
          <div class="api-help-body">
            <p><b>有道智云</b>：<a href="https://ai.youdao.com/" target="_blank" rel="noopener">ai.youdao.com</a> → 应用总览 → 查看应用，取「应用ID + API Keys + 应用密钥」，三行都填上最稳（签名用应用ID，鉴权失败会自动换 API Keys 重试）。</p>
            <p><b>腾讯云</b>：<a href="https://console.cloud.tencent.com/cam/capi" target="_blank" rel="noopener">访问管理 → API 密钥</a> 取 SecretId / SecretKey；地域默认 ap-guangzhou。腾讯云没有纯 API Key 方案，只能用密钥对。</p>
            <p><b>阿里云百炼</b>：<a href="https://bailian.console.aliyun.com/" target="_blank" rel="noopener">百炼控制台 → API-KEY</a>，<b>只要一个 API Key</b>（形如 sk-…），不需要 AccessKey；模型留空用 qwen-plus。</p>
            <p><b>阿里云机器翻译</b>：<a href="https://mt.console.aliyun.com/" target="_blank" rel="noopener">机器翻译控制台</a> 先开通通用版服务，再用 AccessKeyId / AccessKeySecret 对（经典机翻，非大模型）。</p>
            <p><b>火山机器翻译</b>：<a href="https://console.volcengine.com/" target="_blank" rel="noopener">火山引擎控制台</a> 开通机器翻译服务，AccessKey / SecretKey 取自「访问密钥」（经典机翻，非大模型）。</p>
            <p><b>火山方舟（豆包大模型）</b>：<a href="https://console.volcengine.com/ark" target="_blank" rel="noopener">方舟控制台 → API Key</a>，<b>只要一个 API Key</b>；模型填你已开通的模型名或接入点 ID（ep-…），留空用内置默认。</p>
            <p><b>DeepL</b>：<a href="https://www.deepl.com/your-account/keys" target="_blank" rel="noopener">DeepL 账户 → API 密钥</a>，<b>只要一个 API Key</b>；免费版 Key 以 <code>:fx</code> 结尾，程序会自动选 api-free / api 端点。</p>
            <p><b>微软翻译（Azure）</b>：<a href="https://portal.azure.com/" target="_blank" rel="noopener">Azure 门户</a> 创建「翻译服务」资源 → 密钥和终结点 → KEY 1；<b>多服务/区域资源必须填区域</b>（如 eastasia），全局资源可留空。</p>
            <p><b>LibreTranslate</b>：<a href="https://libretranslate.com/" target="_blank" rel="noopener">官方实例</a> 或你自建的实例（Docker 一条命令即可）；自建通常不需要 Key。
            自建域名若不在转发白名单里，把它写进 <code>&lt;存档目录&gt;/proxy-allow.txt</code>（每行一个域名，带 <code>*.</code> 前缀表示后缀匹配）。</p>
            <p class="settings-note"><b>代理怎么接（桌面版生效）</b>：Clash 默认混合端口 <code>7890</code> → <code>http://127.0.0.1:7890</code>；
            v2rayN 默认 HTTP <code>10809</code> / SOCKS <code>10808</code> → <code>http://127.0.0.1:10809</code> 或 <code>socks5://127.0.0.1:10808</code>（也支持 <code>socks5://</code>）。
            订阅链接只能导入到 Clash / v2rayN 客户端里（软件「订阅」→ 粘贴订阅 URL → 更新），程序不直连订阅。
            网页版不走这个设置，直接在加速软件里开「系统代理」或 TUN 模式即可。</p>
            <p class="settings-note">浏览器直连官方接口会被 CORS 拦截：<b>桌面版自带转发</b>；<b>网页版</b>请用
            <code>web/start-server.bat</code>（或 <code>python web/tools/serve.py</code>）启动，即可正常使用官方接口。
            Key 只保存在本机，不联网、不上传。</p>
          </div>
        </details>
      </div>

      <div class="panel settings-section">
        <h3>存储与存档</h3>
        <div class="settings-row">
          <label>存档目录</label>
          <input class="input" data-store-dir value="${IR.esc(s.storageDir || '')}" placeholder="留空 = 默认（我的文档\\InkRead）" style="flex:1;min-width:280px">
          <button class="btn btn-sm btn-primary" data-store-save>保存路径</button>
          <button class="btn btn-sm" data-store-open>打开文件夹</button>
        </div>
        <div class="api-status" data-store-status>存档：检测中…</div>
        <div class="settings-row">
          <button class="btn" data-store-now>立即存档（全部）</button>
          <button class="btn" data-store-restore>从存档恢复</button>
          <button class="btn btn-ghost" data-store-reveal>查看存档说明</button>
        </div>
        <p class="settings-note">生词 / 书籍 / 设置自动写入存档目录，重开自动还原；点「查看存档说明」看文件清单。</p>
      </div>
      <div class="panel settings-section">
        <h3>数据与配置</h3>
        <div class="settings-row">
          <button class="btn btn-primary" data-act="export-config">导出配置（含 API Key）</button>
          <button class="btn" data-act="import-config">导入配置</button>
          <input type="file" accept=".json" data-cfg-file hidden>
        </div>
        <p class="settings-note">换设备只导这一个文件，导入即用（含接口 Key 与全部设置）。</p>
        <div class="settings-row">
          <button class="btn" data-act="export">导出全量备份（词库+设置）</button>
          <button class="btn" data-act="import-bk">恢复全量备份</button>
          <input type="file" accept=".json" data-bk-file hidden>
        </div>
        <p class="settings-note">全量备份额外含生词库；恢复后自动刷新。数据只存本机，不上传。</p>
      </div>`;

    /* ---------- 主题卡片 ---------- */
    const themesEl = IR.$('[data-role="themes"]', mountEl);
    const renderThemes = () => {
      themesEl.innerHTML = '';
      for (const t of IR.THEMES) {
        const el = IR.el('button', { class: 'theme-card' + (IR.settings.data.theme === t.id ? ' selected' : ''), 'data-theme-id': t.id });
        el.innerHTML = `
          <div class="theme-card-name">${t.id === '0' ? t.name + ' · 默认' : t.name}</div>
          <div class="theme-stripe">
            <i style="background:${t.swatch.bg}"></i><i style="background:${t.swatch.panel}"></i>
            <i style="background:${t.swatch.unknown}"></i><i style="background:${t.swatch.learning}"></i>
            <i style="background:${t.swatch.known}"></i><i style="background:${t.swatch.accent}"></i>
          </div>
          <div class="theme-card-desc">${t.desc}</div>`;
        el.addEventListener('click', () => { IR.applyTheme(t.id); renderThemes(); });
        themesEl.appendChild(el);
      }
    };
    renderThemes();

    /* ---------- 三色自定义 ---------- */
    IR.$$('[data-color]', mountEl).forEach(inp => inp.addEventListener('input', () => {
      const k = inp.dataset.color;
      s.colors = s.colors || {};
      s.colors[k] = inp.value;
      IR.settings.save();
      IR.applyTheme(s.theme);
    }));
    IR.$('[data-reset-colors]', mountEl).addEventListener('click', () => {
      s.colors = null;
      IR.settings.save();
      IR.applyTheme(s.theme);
      this.mount(mountEl);
      IR.toast('已恢复主题默认色', 'ok');
    });

    /* ---------- TTS ---------- */
    const voiceSel = IR.$('[data-tts-voice]', mountEl);
    const renderVoices = () => {
      const cur = (s.tts && s.tts.voiceURI) || '';
      const list = IR.tts.voices.length ? IR.tts.voices : [{ voiceURI: '', name: '（未检测到英语音色）', lang: '' }];
      voiceSel.innerHTML = list.map(v =>
        `<option value="${IR.esc(v.voiceURI)}" ${v.voiceURI === cur ? 'selected' : ''}>${IR.esc(v.name)}（${IR.esc(v.lang)}）</option>`).join('');
    };
    renderVoices();
    document.addEventListener('ir:voices', renderVoices);
    voiceSel.addEventListener('change', () => { s.tts = s.tts || {}; s.tts.voiceURI = voiceSel.value; IR.settings.save(); });
    const rate = IR.$('[data-tts-rate]', mountEl);
    rate.addEventListener('input', () => {
      s.tts = s.tts || {}; s.tts.rate = +rate.value;
      IR.$('[data-tts-rate-val]', mountEl).textContent = rate.value + 'x';
      IR.settings.save();
    });
    IR.$('[data-tts-test]', mountEl).addEventListener('click', () => IR.tts.speak('trepidation'));
    IR.$('[data-tts-auto]', mountEl).addEventListener('change', e => {
      s.tts = s.tts || {};
      s.tts.autoSpeak = e.target.checked;
      IR.settings.save();
    });

    /* ---------- 翻译接口：保存 / 测试（所有引擎通用） ---------- */
    const title = name => {
      const h = IR.$(`[data-card="${name}"] h4`, mountEl);
      return h ? h.textContent : name;
    };
    const setStatus = (name, cls, text) => {
      const el = IR.$(`[data-api-status="${name}"]`, mountEl);
      if (!el) return;
      el.className = 'api-status' + (cls ? ' ' + cls : '');
      el.textContent = text;
    };
    const setBadge = (name, ok) => {
      const el = IR.$(`[data-badge="${name}"]`, mountEl);
      if (!el) return;
      const tested = s.api[name] ? s.api[name]._testOk : undefined;
      if (!ok) { el.className = 'api-badge'; el.textContent = '未配置'; return; }
      if (tested === true) { el.className = 'api-badge ok'; el.textContent = '已配置 ✓'; }
      else if (tested === false) { el.className = 'api-badge bad'; el.textContent = '已配置 ✗'; }
      else { el.className = 'api-badge'; el.textContent = '已配置'; }
    };
    const collect = name => {
      const c = IR.$(`[data-card="${name}"]`, mountEl);
      const vals = {};
      if (c) IR.$$('[data-api-in]', c).forEach(inp => { vals[inp.dataset.apiIn.split('.')[1]] = inp.value.trim(); });
      return vals;
    };

    IR.$$('[data-api-save]', mountEl).forEach(btn => btn.addEventListener('click', () => {
      const name = btn.dataset.apiSave;
      if (!s.api[name]) s.api[name] = {};
      Object.assign(s.api[name], collect(name));
      /* 配置改了，上次的测试结果不再可信 */
      if ('_testOk' in s.api[name]) delete s.api[name]._testOk;
      IR.settings.save();
      const ok = filled[name](s.api[name]);
      setBadge(name, ok);
      setStatus(name, ok ? 'ok' : '', ok ? '已保存 ✓（可点「测试」验证连通）' : '已保存（必填项不完整）');
      IR.toast(title(name) + ' 配置已保存', 'ok');
    }));

    IR.$$('[data-api-test]', mountEl).forEach(btn => btn.addEventListener('click', async () => {
      const name = btn.dataset.apiTest;
      const cfg = s.api[name];
      if (cfg && typeof cfg === 'object') Object.assign(cfg, collect(name));   /* 免费引擎无配置字段 */
      if ('_testOk' in (cfg || {})) delete cfg._testOk;                        /* 重测前先清旧结果 */
      IR.settings.save();
      if (filled[name] && cfg) setBadge(name, filled[name](cfg));
      setStatus(name, '', '测试中…');
      try {
        const r = await IR.translate[name]('hello');
        if (cfg && typeof cfg === 'object') { cfg._testOk = true; IR.settings.save(); }
        setBadge(name, true);
        setStatus(name, 'ok', '连接成功 ✓ hello → ' + r.text);
      } catch (err) {
        if (cfg && typeof cfg === 'object') { cfg._testOk = false; IR.settings.save(); }
        setBadge(name, cfg && filled[name] ? filled[name](cfg) : false);
        setStatus(name, 'err', '失败：' + err.message);
      }
    }));

    /* 密码框「显示/隐藏」切换 */
    IR.$$('[data-pw-eye]', mountEl).forEach(btn => btn.addEventListener('click', () => {
      const inp = btn.parentElement && btn.parentElement.querySelector('input');
      if (!inp) return;
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      btn.textContent = show ? '隐藏' : '显示';
    }));

    /* 手动收起过的卡片不再自动展开（每次切换都记住状态） */
    IR.$$('.api-card[data-card]', mountEl).forEach(d => d.addEventListener('toggle', () => {
      const name = d.dataset.card;
      if (!name || !s.api[name]) return;          /* 免费引擎卡（free）不追踪 */
      s.api[name]._collapsed = !d.open;
      IR.settings.save();
    }));

    /* ---------- 自动模式尝试顺序（可自定义，腾讯默认垫底） ---------- */
    const AUTO_LABELS = {
      youdao: '有道智云', tencent: '腾讯云 TMT', aliyun: '阿里云百炼', alimt: '阿里云机器翻译',
      volcano: '火山方舟 · 豆包', volmt: '火山机器翻译', deepl: 'DeepL', ms: '微软翻译', libre: 'LibreTranslate'
    };
    const AUTO_DEFAULT = (IR.translate.AUTO_ENGINES || []).slice();
    const getOrder = () => {
      let o = Array.isArray(s.api.autoOrder) && s.api.autoOrder.length
        ? s.api.autoOrder.filter(n => AUTO_DEFAULT.indexOf(n) >= 0) : [];
      for (const k of AUTO_DEFAULT) if (o.indexOf(k) < 0) o.push(k);   /* 漏掉的引擎补到最后 */
      return o;
    };
    const renderOrder = () => {
      const list = IR.$('[data-order-list]', mountEl);
      if (!list) return;
      const order = getOrder();
      list.innerHTML = order.map((n, i) => `
        <div class="order-row">
          <span class="order-idx">${i + 1}</span>
          <span class="order-name">${AUTO_LABELS[n] || n}</span>
          <span class="order-mark">${filled[n] && filled[n](s.api[n] || {}) ? '已配置' : '未配置'}</span>
          <button type="button" class="btn btn-sm" data-order-up="${i}"${i === 0 ? ' disabled' : ''}>上移</button>
          <button type="button" class="btn btn-sm" data-order-down="${i}"${i === order.length - 1 ? ' disabled' : ''}>下移</button>
        </div>`).join('');
    };
    renderOrder();
    const orderBox = IR.$('[data-order-box]', mountEl);
    if (orderBox) {
      orderBox.addEventListener('click', e => {
        const up = e.target.closest('[data-order-up]');
        const down = e.target.closest('[data-order-down]');
        const reset = e.target.closest('[data-order-reset]');
        const order = getOrder();
        if (up) {
          const i = +up.dataset.orderUp;
          [order[i - 1], order[i]] = [order[i], order[i - 1]];
        } else if (down) {
          const i = +down.dataset.orderDown;
          [order[i], order[i + 1]] = [order[i + 1], order[i]];
        } else if (reset) {
          order.length = 0;
          order.push(...AUTO_DEFAULT);
        } else return;
        s.api.autoOrder = order;
        IR.settings.save();
        renderOrder();
      });
    }

    /* 本地转发状态：桌面版自带；网页版需用 start-server.bat / tools/serve.py 启动 */
    const lpEl = IR.$('[data-localproxy]', mountEl);
    if (lpEl && IR.translate.localProxyAvailable) {
      IR.translate.localProxyAvailable().then(ok => {
        lpEl.className = 'api-status ' + (ok ? 'ok' : '');
        lpEl.textContent = ok
          ? '本地转发：可用 ✓ 官方接口（有道/腾讯/阿里/火山/DeepL/微软/Libre）可直接使用'
          : '本地转发：不可用 —— 网页版请双击 web/start-server.bat 启动（桌面版自带转发，无需设置）';
      });
    }

    /* 点词自动翻译开关 */
    IR.$('[data-auto-trans]', mountEl).addEventListener('change', e => {
      s.reader = s.reader || {};
      s.reader.autoTranslate = e.target.checked;
      IR.settings.save();
      IR.toast(e.target.checked ? '点词将自动翻译' : '已关闭点词自动翻译', 'ok');
    });

    /* 代理访问（桌面版生效；网页版走系统代理） */
    const proxyStatusEl = () => IR.$('[data-proxy-status]', mountEl);
    IR.$('[data-proxy-save]', mountEl).addEventListener('click', () => {
      s.api.proxy = {
        on: IR.$('[data-proxy-on]', mountEl).checked,
        url: IR.$('[data-proxy-url]', mountEl).value.trim()
      };
      IR.settings.save();
      const ok = filled.proxy(s.api.proxy);
      setBadge('proxy', ok);
      const el = proxyStatusEl();
      el.className = 'api-status';
      el.textContent = ok ? '已保存 ✓ · ' + s.api.proxy.url : '已保存（未启用）';
      IR.toast('代理设置已保存', 'ok');
    });
    IR.$('[data-proxy-test]', mountEl).addEventListener('click', async () => {
      const el = proxyStatusEl();
      const isDesktop = !!(window.chrome && window.chrome.webview);
      el.className = 'api-status';
      el.textContent = '测试中…';
      try {
        const r = await IR.translate.google('hello');
        el.className = 'api-status ok';
        el.textContent = '连接成功 ✓ hello → ' + r.text;
      } catch (err) {
        el.className = 'api-status err';
        el.textContent = '失败：' + err.message +
          (isDesktop ? '（检查代理是否已启动、端口是否填对，改完记得先点「保存」）'
                     : '（网页版请开启加速软件的「系统代理」或 TUN 模式）');
      }
    });

    IR.$('[data-engine]', mountEl).addEventListener('change', e => {
      s.api.engine = e.target.value;
      IR.settings.save();
    });

    /* ---------- 存储与存档 ---------- */
    const storeStatus = (cls, text) => {
      const el = IR.$('[data-store-status]', mountEl);
      if (el) { el.className = 'api-status' + (cls ? ' ' + cls : ''); el.textContent = text; }
    };
    IR.filestore.probe().then(ok => {
      if (!ok) { storeStatus('err', '存档：不可用 —— 请用桌面版，或双击 web/start-server.bat 启动网页版'); return; }
      storeStatus('ok', '存档：可用 ✓ 目录 ' + (IR.filestore.root || '(默认)'));
    });
    IR.$('[data-store-save]', mountEl).addEventListener('click', async () => {
      s.storageDir = IR.$('[data-store-dir]', mountEl).value.trim();
      IR.settings.save();
      IR.filestore.ready = null;                 /* 路径变了，重新探测 */
      await IR.filestore.probe();
      if (IR.filestore.ready) {
        storeStatus('ok', '已保存 ✓ 目录 ' + IR.filestore.root);
        IR.toast('存档路径已更新', 'ok');
      } else {
        storeStatus('err', '存档不可用：请用桌面版或 start-server 启动');
      }
    });
    IR.$('[data-store-open]', mountEl).addEventListener('click', () => IR.filestore.openFolder());
    IR.$('[data-store-now]', mountEl).addEventListener('click', async () => {
      const ok = await IR.filestore.probe();
      if (!ok) { storeStatus('err', '存档不可用：请用桌面版或 start-server 启动'); return; }
      const r = await IR.filestore.saveAll();
      storeStatus('ok', `已存档 ✓ 设置 ${r.settings ? '√' : '×'} · 生词 ${IR.vocab.cache.length} 条 · 书籍 ${r.books} 本`);
      IR.toast('已写入存档目录', 'ok');
    });
    IR.$('[data-store-restore]', mountEl).addEventListener('click', async () => {
      const ok = await IR.filestore.probe();
      if (!ok) { storeStatus('err', '存档不可用：请用桌面版或 start-server 启动'); return; }
      if (!confirm('从存档恢复会以磁盘文件覆盖本机当前数据（生词 / 书籍 / 设置），继续？')) return;
      const r = await IR.filestore.saveAll();     /* 先保证磁盘是最新的 */
      void r;
      await IR.filestore.restore();
      IR.toast('已按存档刷新，正在重新加载…', 'ok');
      setTimeout(() => location.reload(), 700);
    });
    IR.$('[data-store-reveal]', mountEl).addEventListener('click', async () => {
      const ok = await IR.filestore.probe();
      const dir = (ok && IR.filestore.root) || '(默认：我的文档\\InkRead)';
      IR.modal.open(`
        <h3 style="margin-top:0">存档说明</h3>
        <p style="font-size:.86rem;line-height:1.8">目录：<code>${IR.esc(dir)}</code></p>
        <ul style="font-size:.86rem;line-height:1.9">
          <li><code>vocab.csv</code> —— 生词/在学/已学全量表格（Excel、WPS 可直接打开编辑）</li>
          <li><code>vocab.json</code> —— 同上，供程序无损读回</li>
          <li><code>books/&lt;书名&gt;.json</code> —— 每本已导入书籍的正文与阅读进度</li>
          <li><code>settings.json</code> —— 全部设置 + 翻译接口 Key（换端复制这个文件即可）</li>
        </ul>
        <p style="font-size:.82rem;color:var(--text-3)">自动存档时机：点词标记状态、批量操作、导入书籍、修改设置时；
        另外程序退出前会补存一次。</p>
        <div class="modal-foot"><button class="btn" onclick="IR.modal.close()">知道了</button>
        <button class="btn btn-ghost" onclick="IR.filestore.openFolder()">打开文件夹</button></div>`);
    });

    /* ---------- 数据与配置 ---------- */
    IR.$('[data-act="export"]', mountEl).addEventListener('click', () => IR.exportBackup());
    const bkInput = IR.$('[data-bk-file]', mountEl);
    IR.$('[data-act="import-bk"]', mountEl).addEventListener('click', () => bkInput.click());
    bkInput.addEventListener('change', () => {
      if (bkInput.files[0]) IR.importBackup(bkInput.files[0]);
      bkInput.value = '';
    });
    IR.$('[data-act="export-config"]', mountEl).addEventListener('click', () => IR.exportConfig());
    const cfgInput = IR.$('[data-cfg-file]', mountEl);
    IR.$('[data-act="import-config"]', mountEl).addEventListener('click', () => cfgInput.click());
    cfgInput.addEventListener('change', () => {
      if (cfgInput.files[0]) IR.importConfig(cfgInput.files[0]);
      cfgInput.value = '';
    });
  }
};
