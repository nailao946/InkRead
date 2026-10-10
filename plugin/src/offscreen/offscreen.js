/* InkRead Video — 离屏文档：替 service worker 跑 File System Access
 *
 * 只做一件事：收到 { type:'ir:fs', op, payload } → 用 IndexedDB 里存的目录句柄执行 → 回结果。
 * 不碰 chrome.storage（离屏文档只有 runtime 相关 API 可用），也不做业务判断，
 * 业务逻辑全在 src/shared/vocab-sync.js 与 background/sw.js 里。
 */
import { api } from '../shared/api.js';
import { runOp, getDir } from '../shared/fsh.js';

api.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || msg.type !== 'ir:fs') return false;
  /* 探针：不碰文件系统，只证明离屏文档起来了、模块加载正常、消息通道通 */
  if (msg.op === 'ping') { reply({ ok: true, pong: true, hasFsa: typeof FileSystemDirectoryHandle !== 'undefined' }); return false; }
  (async () => {
    try {
      const dir = await getDir();
      if (!dir) return reply({ ok: false, error: 'no-dir' });
      reply(await runOp(dir, msg.op, msg.payload));
    } catch (e) {
      reply({ ok: false, error: String((e && e.name ? e.name + ': ' : '') + ((e && e.message) || e)) });
    }
  })();
  return true;   /* 异步回复，保持消息通道 */
});
