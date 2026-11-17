"""文件：desktop/tools/gen-licenses.py
职责：从 backend 的 Python 环境生成一份「第三方许可全文」，随安装包分发。

为什么需要它：Apache-2.0 与 MPL-2.0 的依赖要求随产物附许可副本，而 PyInstaller 只打
.py/.pyd，绝大多数 wheel 的 LICENSE 并不会进 exe。仓库根目录的 THIRD-PARTY-NOTICES.md
只有「包名 → 许可类型」的清单，缺的是全文。

为什么是脚本而不是手抄：依赖升级后必须能一行命令重现同一份文件。手抄的全文没人能复核，
半年后也没人知道它对应哪一版依赖。

口径：
  - 只做「读取 + 去重 + 排版」，**不编造任何法律文本**：全文全部来自各包自己的
    *.dist-info/licenses/；没有携带许可文件的包在第 3 节单独列出，不代填。
  - 同一份全文只出现一次：按「去掉行尾空白后的正文」哈希去重，清单用附录编号引用。
  - 覆盖 backend 环境的**全部** Python 依赖（含只在开发/打包期使用、不随产物分发的那几个），
    宁可多列也不漏；哪个包进产物见 THIRD-PARTY-NOTICES.md 第 2.1 / 2.2 / 2.3 节。

用法：
  cd backend && uv sync                      # 先确保 .venv 是最新的
  cd ../desktop && python tools/gen-licenses.py
  python tools/gen-licenses.py --check       # 只校验已生成的文件是否与当前环境一致
环境变量：SUIXINWENDA_PY_ENV 可指定 Python 环境目录（默认 backend/.venv）。
退出码：0 = 生成成功 / 校验一致；1 = 缺少环境、读不到元数据或校验不一致。
"""
import argparse
import hashlib
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent          # desktop/
DEFAULT_ENV = ROOT.parent / "backend" / ".venv"
DEFAULT_OUT = ROOT / "build" / "THIRD-PARTY-LICENSES.txt"

# Windows 控制台默认 cp936，经 npm / 管道输出会把中文变成乱码
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

# PEP 639 之后 wheel 把许可放在 dist-info/licenses/ 下；老 wheel 只有散落在 dist-info 根目录的 LICENSE*
LICENSE_FILE_PATTERN = re.compile(r"^(LICEN[CS]E|COPYING|NOTICE)", re.IGNORECASE)
LICENSE_CLASSIFIER_PREFIX = "License :: OSI Approved :: "

# classifier / License 字段 → 展示用短名（只影响清单里的标签，不作为合规结论）。
# 未命中的 classifier 会原样保留名字（见 _license_label），绝不因缺映射而退化成关键词猜测——
# PyInstaller 就是一例：它的正文里同时含 GPL 与 Apache 片段，靠猜会把它标成 Apache-2.0。
CLASSIFIER_LABELS = {
    "MIT License": "MIT",
    "Apache Software License": "Apache-2.0",
    "BSD License": "BSD",
    "Mozilla Public License 2.0 (MPL 2.0)": "MPL-2.0",
    "Python Software Foundation License": "PSF-2.0",
    "ISC License (ISCL)": "ISC",
    "The Unlicense (Unlicense)": "Unlicense",
    "GNU General Public License v2 (GPLv2)": "GPL-2.0",
    "GNU General Public License v2 or later (GPLv2+)": "GPL-2.0-or-later",
    "GNU General Public License v3 (GPLv3)": "GPL-3.0",
    "GNU General Public License v3 or later (GPLv3+)": "GPL-3.0-or-later",
    "GNU Lesser General Public License v2 (LGPLv2)": "LGPL-2.0",
    "GNU Lesser General Public License v2 or later (LGPLv2+)": "LGPL-2.0-or-later",
    "GNU Lesser General Public License v3 (LGPLv3)": "LGPL-3.0",
    "GNU Lesser General Public License v3 or later (LGPLv3+)": "LGPL-3.0-or-later",
    "GNU Affero General Public License v3": "AGPL-3.0",
    "GNU Affero General Public License v3 or later (AGPLv3+)": "AGPL-3.0-or-later",
}

# License 字段写成长名时的规范化（同一个 MIT 有 MIT / MIT License / MIT-0 等写法）
DECLARED_ALIASES = {
    "MIT License": "MIT",
    "MIT licence": "MIT",
    "BSD License": "BSD",
    "Apache License 2.0": "Apache-2.0",
    "Apache-2.0": "Apache-2.0",
    "MPL-2.0": "MPL-2.0",
}

# 正文关键词 → 标签：classifier 与 License 字段都为空的现代 wheel 不少（PEP 639 只写 license-files）
TEXT_HINTS = (
    ("apache license", "Apache-2.0"),
    ("mozilla public license", "MPL-2.0"),
    ("python software foundation", "PSF-2.0"),
    ("isc license", "ISC"),
    ("permission is hereby granted, free of charge", "MIT"),
    ("redistribution and use in source and binary forms", "BSD"),
)

SECTION_RULE = "-" * 100


def _read(path: Path) -> str:
    """按 UTF-8 读；个别 wheel 的许可文件是 latin-1，读坏了也不能中断生成。"""
    for encoding in ("utf-8", "latin-1"):
        try:
            return path.read_text(encoding=encoding)
        except UnicodeDecodeError:
            continue
    return path.read_bytes().decode("utf-8", errors="replace")


def _normalize(text: str) -> str:
    """去重键：忽略行尾空白（同一份 Apache 全文常因换行差异被算成两份）。"""
    return "\n".join(line.rstrip() for line in text.replace("\r\n", "\n").split("\n")).strip()


def _parse_metadata(path: Path) -> tuple[dict, list[str]]:
    """只解析 METADATA 头部（空行之后是长描述）。不用 importlib.metadata 是怕它解析已安装包。"""
    fields = {"Name": "", "Version": "", "License": "", "Home-page": ""}
    classifiers: list[str] = []
    for line in _read(path).split("\n"):
        if not line.strip():
            break
        if line.startswith("Classifier: "):
            classifiers.append(line[len("Classifier: ") :].strip())
            continue
        for key in fields:
            prefix = f"{key}: "
            if line.startswith(prefix) and not fields[key]:
                fields[key] = line[len(prefix) :].strip()
    return fields, classifiers


def _license_label(package: dict) -> str:
    """许可标签：classifier > License 字段 > 正文关键词。

    classifier 是包的作者自己填的，是这里最可信的一手信息；映射表里没有这项时**原样保留**
    它写下的名字，不再往下猜。多许可（例如 hooks-contrib 同时是 Apache-2.0 与 GPL-2.0）
    按 classifier 顺序拼接，避免只报一个。
    """
    labels: list[str] = []
    for classifier in package["classifiers"]:
        if not classifier.startswith(LICENSE_CLASSIFIER_PREFIX):
            continue
        name = classifier[len(LICENSE_CLASSIFIER_PREFIX) :]
        label = CLASSIFIER_LABELS.get(name, name)
        if label not in labels:
            labels.append(label)
    if labels:
        return " / ".join(labels)

    declared = package["declared"]
    if declared and len(declared) <= 40 and "\n" not in declared:
        return DECLARED_ALIASES.get(declared, declared)
    haystack = "\n".join(package["bodies"]).lower() or declared.lower()
    for needle, label in TEXT_HINTS:
        if needle in haystack:
            return label
    return "见全文"


def _site_packages(env_dir: Path) -> Path:
    candidates = [env_dir / "Lib" / "site-packages", *sorted(env_dir.glob("lib/python*/site-packages"))]
    for candidate in candidates:
        if candidate.is_dir():
            return candidate
    raise SystemExit(f"找不到 site-packages：{env_dir}（先在 backend/ 下跑 uv sync）")


def _license_bodies(dist_info: Path) -> list[str]:
    """一个包携带的许可正文：优先 licenses/，那里为空再回退 dist-info 根目录。"""
    def grab(root: Path, recursive: bool) -> list[str]:
        files = root.rglob("*") if recursive else root.iterdir()
        return [
            _normalize(_read(file))
            for file in sorted(files)
            if file.is_file() and LICENSE_FILE_PATTERN.match(file.name)
        ]

    license_dir = dist_info / "licenses"
    bodies = grab(license_dir, recursive=True) if license_dir.is_dir() else []
    if not bodies:
        bodies = grab(dist_info, recursive=False)
    return [body for body in bodies if body]


def _collect(env_dir: Path) -> list[dict]:
    """扫描所有 dist-info，返回按包名排序的包信息列表。"""
    packages = []
    for dist_info in sorted(_site_packages(env_dir).glob("*.dist-info")):
        metadata_file = dist_info / "METADATA"
        if not metadata_file.is_file():
            continue
        fields, classifiers = _parse_metadata(metadata_file)
        package = {
            "name": fields["Name"] or dist_info.name.split("-")[0],
            "version": fields["Version"],
            "homepage": fields["Home-page"],
            "declared": fields["License"],
            "classifiers": classifiers,
            "bodies": _license_bodies(dist_info),
        }
        package["label"] = _license_label(package)
        packages.append(package)
    packages.sort(key=lambda item: item["name"].lower())
    return packages


def build(env_dir: Path) -> tuple[str, list[dict], list[list[str]]]:
    """返回（文件正文, 包清单, 附录适用包列表）。附录顺序按首次出现，编号 A1、A2……"""
    packages = _collect(env_dir)

    order: dict[str, int] = {}          # 正文哈希 → 附录下标
    appendix_text: list[str] = []
    appendix_users: list[list[str]] = []

    for package in packages:
        refs: list[str] = []
        for body in package["bodies"]:
            digest = hashlib.sha256(body.encode("utf-8")).hexdigest()
            if digest not in order:
                order[digest] = len(appendix_text)
                appendix_text.append(body)
                appendix_users.append([])
            index = order[digest]
            appendix_users[index].append(package["name"])
            ref = f"A{index + 1}"
            if ref not in refs:
                refs.append(ref)
        package["refs"] = refs

    missing = [package for package in packages if not package["refs"]]
    # 列宽按实际内容算：多许可标签（如 "Apache-2.0 / GPL-2.0"）会超过固定宽度，
    # 固定 16 会让标签和「全文」列粘连成 "GPL-2.0A44"，肉眼与机器都解析不出来
    name_width = max([len("包名")] + [len(package["name"]) for package in packages]) + 2
    version_width = max([len("版本")] + [len(package["version"]) for package in packages]) + 2
    label_width = max([len("许可")] + [len(package["label"]) for package in packages]) + 2
    lines = [
        "第三方许可全文",
        "=" * 100,
        "本文件由 desktop/tools/gen-licenses.py 从 backend 的 Python 环境生成，请勿手工编辑。重新生成：",
        "    cd backend && uv sync",
        "    cd ../desktop && python tools/gen-licenses.py",
        "",
        "覆盖范围：backend 环境的全部 Python 依赖，含只在开发与打包期使用、不随产物分发的那几个",
        "（哪些进产物见仓库根目录 THIRD-PARTY-NOTICES.md 第 2.1 / 2.2 / 2.3 节）。",
        "每个包随 wheel 携带的许可文件按正文去重后放在第 2 节，同一份全文只出现一次；",
        "清单「全文」列是附录编号，标「—」的表示该 wheel 内没有许可文件，见第 3 节。",
        "",
        "桌面端运行时（Electron / Chromium）的许可由 electron-builder 自动附带：",
        "    resources/LICENSE.electron.txt、resources/LICENSES.chromium.html",
        "项目自有许可与品牌条款：仓库根目录 LICENSE、NOTICE、THIRD-PARTY-NOTICES.md。",
        "",
        SECTION_RULE,
        f"1. 依赖清单（共 {len(packages)} 个包，{len(appendix_text)} 份唯一许可全文）",
        SECTION_RULE,
        f"{'包名':<{name_width}}{'版本':<{version_width}}{'许可':<{label_width}}全文",
    ]
    for package in packages:
        refs = ", ".join(package["refs"]) or "—"
        lines.append(
            f"{package['name']:<{name_width}}{package['version']:<{version_width}}"
            f"{package['label']:<{label_width}}{refs}"
        )

    lines += ["", SECTION_RULE, "2. 许可全文", SECTION_RULE, ""]
    for index, body in enumerate(appendix_text):
        users = ", ".join(sorted(set(appendix_users[index]), key=str.lower))
        lines += [f"[A{index + 1}] 适用包：{users}", SECTION_RULE, body, ""]

    if missing:
        lines += [
            SECTION_RULE,
            f"3. wheel 内未携带许可文件的包（{len(missing)} 个，请以下游项目主页的声明为准）",
            SECTION_RULE,
            f"{'包名':<{name_width}}{'版本':<{version_width}}主页",
        ]
        for package in missing:
            lines.append(
                f"{package['name']:<{name_width}}{package['version']:<{version_width}}"
                f"{package['homepage'] or '（元数据未提供）'}"
            )
        lines.append("")
    return "\n".join(lines) + "\n", packages, appendix_users


def main() -> int:
    parser = argparse.ArgumentParser(description="生成第三方许可全文（随安装包分发）")
    parser.add_argument("--env", default=os.environ.get("SUIXINWENDA_PY_ENV", str(DEFAULT_ENV)), help="Python 环境目录")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="输出文件")
    parser.add_argument("--check", action="store_true", help="只校验，不写盘")
    args = parser.parse_args()

    out_path = Path(args.out)
    text, packages, appendix = build(Path(args.env))

    if args.check:
        if not out_path.is_file():
            print(f"[FAIL] 还没有生成过：{out_path}")
            return 1
        if out_path.read_text(encoding="utf-8") != text:
            print(f"[FAIL] {out_path} 与当前依赖不一致，请重新生成：python tools/gen-licenses.py")
            return 1
        print(f"[ OK ] 与当前环境一致：{len(packages)} 个包、{len(appendix)} 份许可全文")
        return 0

    out_path.parent.mkdir(parents=True, exist_ok=True)
    # newline="\n"：Windows 上也写 LF，重新生成不会因换行差异产生 diff 噪音
    with out_path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)

    size_kb = out_path.stat().st_size / 1024
    missing = [package["name"] for package in packages if not package["refs"]]
    print(f"[ OK ] 已生成 {out_path}（{size_kb:.0f} KB）：{len(packages)} 个包、{len(appendix)} 份唯一许可全文")
    if missing:
        print(f"[WARN] {len(missing)} 个包没有携带许可文件，已列进第 3 节：{', '.join(missing)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
