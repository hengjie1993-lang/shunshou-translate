#!/usr/bin/env python3
"""
打发布包（给 GitHub Releases 用）。

只收运行时文件，把 tools/ test/ docs/ README 这些开发期产物全部排除 ——
用户下载后解压加载，包里不该混进任何调试脚本或截图。

用法： python tools/build.py
产物： dist/shunshou-translate-<version>.zip（manifest.json 位于压缩包根目录）
"""
import json
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")

# 运行时目录 / 文件白名单。新增运行时目录时记得加进来。
INCLUDE_DIRS = ["content", "lib", "options", "popup", "icons"]
INCLUDE_FILES = ["manifest.json", "background.js"]

# 即便在运行时目录里也要排除的东西
EXCLUDE_SUFFIX = (".map", ".md", ".log", ".dev-keys.json")
EXCLUDE_NAMES = {".DS_Store", "Thumbs.db", ".dev-keys.json"}


def iter_runtime_files():
    for name in INCLUDE_FILES:
        p = os.path.join(ROOT, name)
        if not os.path.isfile(p):
            sys.exit(f"❌ 缺少必需文件: {name}")
        yield p
    for d in INCLUDE_DIRS:
        base = os.path.join(ROOT, d)
        if not os.path.isdir(base):
            sys.exit(f"❌ 缺少必需目录: {d}")
        for dirpath, _, filenames in os.walk(base):
            for fn in filenames:
                if fn in EXCLUDE_NAMES or fn.endswith(EXCLUDE_SUFFIX):
                    continue
                yield os.path.join(dirpath, fn)


def main():
    manifest = json.load(open(os.path.join(ROOT, "manifest.json"), encoding="utf-8"))
    version = manifest["version"]
    os.makedirs(DIST, exist_ok=True)
    out = os.path.join(DIST, f"shunshou-translate-{version}.zip")

    files = sorted(iter_runtime_files())
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for p in files:
            arc = os.path.relpath(p, ROOT).replace(os.sep, "/")
            z.write(p, arc)

    size = os.path.getsize(out)
    print(f"✅ 打包完成  {out}")
    print(f"   版本 {version}   {len(files)} 个文件   {size / 1024:.1f} KB")
    print("   包内清单：")
    for p in files:
        print("     " + os.path.relpath(p, ROOT).replace(os.sep, "/"))

    # 上架前自检：这些项在审核里被问到的概率最高
    problems = []
    if not os.path.exists(os.path.join(ROOT, "icons", "icon128.png")):
        problems.append("缺 128×128 图标")
    hosts = manifest.get("host_permissions", [])
    if not any("translate.googleapis.com" in h for h in hosts):
        problems.append("host_permissions 里没有谷歌翻译通道（功能会失效）")
    if "<all_urls>" not in hosts:
        problems.append("host_permissions 缺 <all_urls>（任意网页输入框都翻译不了）")
    if manifest.get("content_security_policy"):
        problems.append("自定义 CSP 容易被审核质疑，除非确有需要建议去掉")
    if problems:
        print("\n⚠️ 自检发现问题：")
        for p in problems:
            print("   - " + p)
    else:
        print("\n✅ 自检通过")


if __name__ == "__main__":
    main()
