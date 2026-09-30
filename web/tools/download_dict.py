#!/usr/bin/env python3
# 墨读 InkRead — M3 词典数据源下载
# 数据源：ECDICT（github.com/skywind3000/ECDICT，MIT 协议）
#   - ecdict.csv：全量词表（含 word/phonetic/definition/translation/pos/... 共 13 列，UTF-8）
# 该脚本幂等：若缓存文件已存在则跳过。
# 用法：python download_dict.py
import os
import sys
import shutil
import urllib.request

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(SCRIPT_DIR, "cache")
OUT = os.path.join(CACHE_DIR, "ecdict.csv")

# 首选 raw.githubusercontent；jsdelivr 对大文件会 403，仅作兜底
URLS = [
    "https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv",
    "https://cdn.jsdelivr.net/gh/skywind3000/ECDICT@master/ecdict.csv",
    "https://gitcode.net/mirrors/skywind3000/ECDICT/-/raw/master/ecdict.csv",
]


def main():
    if os.path.exists(OUT) and os.path.getsize(OUT) > 1_000_000:
        print(f"[skip] 缓存已存在：{OUT} ({os.path.getsize(OUT)//1024//1024} MB)")
        return
    os.makedirs(CACHE_DIR, exist_ok=True)
    last_err = None
    for u in URLS:
        try:
            print(f"[get] {u}")
            req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=120) as r, open(OUT, "wb") as f:
                shutil.copyfileobj(r, f)
            size = os.path.getsize(OUT)
            print(f"[ok] 已保存 {OUT} ({size//1024//1024} MB)")
            if size < 1_000_000:
                os.remove(OUT)
                raise IOError("文件过小，疑似下载到错误内容")
            return
        except Exception as e:  # noqa: BLE001
            last_err = e
            print(f"[fail] {u} -> {e}")
    print("[error] 所有数据源均下载失败。请手动下载 ecdict.csv 到 tools/cache/ 后重试。", file=sys.stderr)
    if last_err:
        print("最后错误：", last_err, file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
    main()
