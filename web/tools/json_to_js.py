#!/usr/bin/env python3
# 墨读 InkRead — 词典分片 JSON → JS 转换
# 把 web/dict/*.json 转成 web/dict/*.js，内容为 window.IR_DICT_<letter> = {...};
# 目的：file:// 双击打开时 fetch 会被浏览器 CORS 拦截，改用 <script> 标签加载 JS 即可离线查词。
# 幂等：若 js 已存在且比对应 json 新，则跳过。
import os
import json
import glob

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DICT_DIR = os.path.join(os.path.dirname(SCRIPT_DIR), "dict")

def main():
    jsons = sorted(glob.glob(os.path.join(DICT_DIR, "*.json")))
    if not jsons:
        print("[error] 未找到 dict/*.json", file=__import__("sys").stderr)
        return 1
    for jp in jsons:
        letter = os.path.splitext(os.path.basename(jp))[0]
        jsp = os.path.join(DICT_DIR, letter + ".js")
        if os.path.exists(jsp) and os.path.getmtime(jsp) >= os.path.getmtime(jp):
            continue
        with open(jp, encoding="utf-8") as f:
            data = f.read().strip()
        # 去掉可能的尾随 BOM/空白，确保是合法 JSON 对象
        with open(jsp, "w", encoding="utf-8") as out:
            out.write("window.IR_DICT_%s=%s;" % (letter, data))
        print("  %s.js  (%d KB)" % (letter, os.path.getsize(jsp) // 1024))
    print("[ok] 已生成 %d 个词典 JS 分片" % len(jsons))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
