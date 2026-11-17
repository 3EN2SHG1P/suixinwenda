"""文件：desktop/tools/gen-icons.py
职责：从设计原图一次生成全部图标资产（build/icon.ico + 三张界面 png），并做像素级自校验。
口径：
  - 原图只读，脚本绝不写入原图目录；
  - 派生规则集中在本文件，原图同名覆盖后重跑一次即可，不会出现「仓库里还是旧配色」的静默漂移；
  - 校验不通过直接非零退出，可放进提交前检查。
用法：
  python tools/gen-icons.py                      # 生成 + 校验
  python tools/gen-icons.py --check              # 只校验不写盘
  python tools/gen-icons.py --src "<原图目录>"      # 指定原图目录
原图是作者自有的美术资产，**不在本仓库内**：只有需要重新生成图标的维护者才用得到本脚本，
日常开发、CI 与提交前检查都不依赖它。
默认原图目录：%USERPROFILE%\\Desktop\\logo演化\\随心问答logo_终稿（可用环境变量 SUIXINWENDA_LOGO_SRC 覆盖）；缺原图时脚本直接报错退出。
退出码：0 = 全部通过；1 = 缺原图 / 校验失败。
"""

import argparse
import hashlib
import os
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageStat

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "src" / "renderer" / "assets"
BUILD = ROOT / "build"

DEFAULT_SRC = Path.home() / "Desktop" / "logo演化" / "随心问答logo_终稿"

BORDERED = "随心问答_logo_1024.png"  # 带边框：exe / 安装包 / 快捷方式 / README
LIGHT_TILE = "随心问答_logo_方形1024_上架用.png"  # 无边框浅色：标题栏与小窗（浅色主题）
DARK_TRANS = "随心问答_logo_方形1024_上架用_深色主题_透明背景.png"  # 无边框深色：同上（深色主题）
SMALL_DIR = "_其他尺寸"
SMALL_FILES = {
    32: "随心问答_logo_32.png",
    48: "随心问答_logo_48.png",
    64: "随心问答_logo_64.png",
    128: "随心问答_logo_128.png",
    256: "随心问答_logo_256.png",
}

MARK_SIZE = 256
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
PAD_RATIO = 0.04  # 两套素材共用裁切框，外扩 4%：切换主题时 logo 不跳位
INK_THRESHOLD = 128  # 浅色原图靠「深墨迹」找包围盒
ALPHA_THRESHOLD = 32  # 深色原图靠 alpha 找包围盒
MAE_LIMIT = 1.0  # 允许的最大平均像素误差（0 表示逐像素一致）

problems = []

# Windows 控制台默认 cp936，经 npm 管道输出会把中文变成乱码：统一按 UTF-8 写
for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8", errors="replace")


def fail(message):
    problems.append(message)
    print(f"[FAIL] {message}")


def info(message):
    print(f"[ OK ] {message}")


def mae_of(left, right):
    """两张 RGBA 图的平均绝对误差（只看 RGB，0~255）。"""
    diff = ImageChops.difference(left.convert("RGBA"), right.convert("RGBA")).convert("RGB")
    mean = ImageStat.Stat(diff).mean
    return round(sum(mean) / 3, 2)


def ink_bbox_fraction(path):
    im = Image.open(path).convert("RGB")
    mask = im.convert("L").point(lambda v: 255 if v < INK_THRESHOLD else 0)
    box = mask.getbbox()
    if box is None:
        raise SystemExit(f"原图里找不到墨迹：{path}")
    w, h = im.size
    return (box[0] / w, box[1] / h, box[2] / w, box[3] / h)


def alpha_bbox_fraction(path):
    im = Image.open(path).convert("RGBA")
    mask = im.split()[3].point(lambda v: 255 if v >= ALPHA_THRESHOLD else 0)
    box = mask.getbbox()
    if box is None:
        raise SystemExit(f"原图里找不到不透明像素：{path}")
    w, h = im.size
    return (box[0] / w, box[1] / h, box[2] / w, box[3] / h)


def shared_crop_box(src):
    """浅色墨迹包围盒 ∪ 深色 alpha 包围盒，取正方形并外扩，保证两套素材几何一致。"""
    lx0, ly0, lx1, ly1 = ink_bbox_fraction(src / LIGHT_TILE)
    dx0, dy0, dx1, dy1 = alpha_bbox_fraction(src / DARK_TRANS)
    x0, y0 = min(lx0, dx0), min(ly0, dy0)
    x1, y1 = max(lx1, dx1), max(ly1, dy1)
    side = max(x1 - x0, y1 - y0) * (1 + 2 * PAD_RATIO)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    nx0, ny0 = cx - side / 2, cy - side / 2
    # 越界就整体平移回画布，保持正方形（不裁掉笔触）
    nx0 = min(max(nx0, 0.0), max(1.0 - side, 0.0))
    ny0 = min(max(ny0, 0.0), max(1.0 - side, 0.0))
    return (nx0, ny0, nx0 + side, ny0 + side)


def crop_mark(path, box, size=MARK_SIZE):
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    px_box = (
        round(box[0] * w),
        round(box[1] * h),
        round(box[2] * w),
        round(box[3] * h),
    )
    return im.crop(px_box).resize((size, size), Image.LANCZOS)


def ico_frames(src):
    """32~256 用设计稿逐尺寸导出；16/24 由 48 版降采样（比 1024 直缩锐度高）。"""
    base48 = None
    frames = {}
    for size, name in SMALL_FILES.items():
        path = src / SMALL_DIR / name
        if path.exists():
            frames[size] = Image.open(path).convert("RGBA")
        else:
            print(f"[WARN] 缺少逐尺寸原图 {name}，改用 {BORDERED} 降采样")
            frames[size] = Image.open(src / BORDERED).convert("RGBA").resize((size, size), Image.LANCZOS)
        if size == 48:
            base48 = frames[size]
    for size in (16, 24):
        frames[size] = base48.resize((size, size), Image.LANCZOS)
    return frames


def build_ico(src, frames, target):
    frames[256].save(
        target,
        format="ICO",
        sizes=[(size, size) for size in ICO_SIZES],
        append_images=[frames[size] for size in ICO_SIZES[:-1]],
    )


def check_ico(path, frames):
    ico = Image.open(path)
    got = sorted(ico.info.get("sizes", []))
    want = [(size, size) for size in ICO_SIZES]
    if got != want:
        fail(f"{path.name} 帧尺寸不对：{got}，期望 {want}")
        return
    for size in ICO_SIZES:
        frame = Image.open(path)
        frame.size = (size, size)
        frame.load()
        frame = frame.convert("RGBA")
        if frame.split()[3].getextrema() == (255, 255):  # 全不透明说明 alpha 丢了
            fail(f"{path.name} 的 {size}px 帧丢了 alpha")
            continue
        err = mae_of(frame, frames[size])
        if err > MAE_LIMIT:
            fail(f"{path.name} 的 {size}px 帧与原图不一致（MAE={err}）")
    info(f"{path.name}：{len(ICO_SIZES)} 帧尺寸齐全，逐帧与原图比对一致")


def check_mark(path, expected, label):
    if not path.exists():
        fail(f"缺少 {path.name}")
        return
    err = mae_of(Image.open(path), expected)
    if err > MAE_LIMIT:
        fail(f"{path.name} 与{label}不一致（MAE={err}），原图可能已被同名覆盖，请重跑本脚本")
    else:
        info(f"{path.name}：与{label}逐像素一致")


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description="从设计原图生成并校验应用图标资产")
    parser.add_argument("--src", default=os.environ.get("SUIXINWENDA_LOGO_SRC", str(DEFAULT_SRC)))
    parser.add_argument("--check", action="store_true", help="只校验不写盘")
    args = parser.parse_args()

    src = Path(args.src)
    required = [BORDERED, LIGHT_TILE, DARK_TRANS]
    missing = [name for name in required if not (src / name).exists()]
    if missing:
        print(f"原图目录：{src}")
        raise SystemExit(f"缺少原图：{', '.join(missing)}（用 --src 指定目录）")

    box = shared_crop_box(src)
    light = crop_mark(src / LIGHT_TILE, box)
    dark = crop_mark(src / DARK_TRANS, box)
    frames = ico_frames(src)

    if not args.check:
        light.save(ASSETS / "logo-mark.png", optimize=True)
        dark.save(ASSETS / "logo-mark-dark.png", optimize=True)
        # README 用带边框原图，字节级复制：保证与设计稿完全同源
        (ASSETS / "logo.png").write_bytes((src / BORDERED).read_bytes())
        build_ico(src, frames, BUILD / "icon.ico")

    check_mark(ASSETS / "logo-mark.png", light, "浅色原图裁切")
    check_mark(ASSETS / "logo-mark-dark.png", dark, "深色原图裁切")
    check_ico(BUILD / "icon.ico", frames)

    if not (ASSETS / "logo.png").exists():
        fail("缺少 logo.png")
    elif sha256(ASSETS / "logo.png") != sha256(src / BORDERED):
        fail("logo.png 与原图字节不一致（README 展示图会漂移）")
    else:
        info("logo.png：与带边框原图 SHA256 一致")

    if problems:
        print(f"\n校验失败 {len(problems)} 项")
        return 1
    print("\n全部通过" + ("（仅校验，未写盘）" if args.check else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
