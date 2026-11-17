"""文件：desktop/tools/gen-social-preview.py
职责：生成 GitHub 仓库的社交预览图（1280x640），上传到 Settings → Social preview。

为什么需要：别人把仓库链接贴到微信 / Twitter / 论坛时，GitHub 会抓这张图做卡片；
不传就是一片灰底加仓库名，等于放弃第一印象。

为什么用脚本而不是 PSD：配色与文案要跟界面保持一致，界面改了这里要能一行重跑，
而不是「找一下当初那张图存在哪」。两套配色都取自 src/renderer/styles.css 的主题变量。

用法：
  python tools/gen-social-preview.py                    # 浅色版（默认），写到 .github/social-preview.png
  python tools/gen-social-preview.py --theme dark       # 深色版
  python tools/gen-social-preview.py --out D:/x.png     # 换输出位置
环境变量：SUIXINWENDA_PREVIEW_FONT 指定中文字体（默认用系统微软雅黑）。
退出码：0 = 已生成；1 = 缺字体 / 缺 logo。
"""
import argparse
import os
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent          # desktop/
ASSETS = ROOT / "src" / "renderer" / "assets"
DEFAULT_OUT = ROOT.parent / ".github" / "social-preview.png"

# Windows 控制台默认 cp936，经 npm / 管道输出会把中文变成乱码：统一按 UTF-8 写
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

# 尺寸固定 1280x640：GitHub 推荐 2:1，社交卡片按 1.91:1 裁切后仍能保住主体
WIDTH, HEIGHT = 1280, 640

# 两套配色都取自 styles.css：浅色用 --accent #0e7c6e，深色用 #3ed9be。
# 默认走浅色——深色卡片在信息流里容易与周围的深色界面糊成一片。
THEMES = {
    "light": {
        "bg_top": (255, 255, 255),
        "bg_bottom": (236, 242, 240),
        "accent": (14, 124, 110),
        "text_main": (18, 21, 24),
        "text_sub": (104, 114, 124),
        "text_dim": (140, 148, 155),
        "line": (215, 223, 220),
        "logo": ASSETS / "logo-mark.png",
        "glow": (14, 124, 110, 26),
    },
    "dark": {
        "bg_top": (22, 25, 28),
        "bg_bottom": (12, 14, 16),
        "accent": (62, 217, 190),
        "text_main": (232, 237, 241),
        "text_sub": (138, 148, 158),
        "text_dim": (90, 99, 108),
        "line": (42, 48, 54),
        "logo": ASSETS / "logo-mark-dark.png",
        "glow": (62, 217, 190, 34),
    },
}

FONT_CANDIDATES = (
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\msyh.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
)
REGULAR_CANDIDATES = (
    r"C:\Windows\Fonts\msyh.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
)


def _font(candidates, size):
    """按顺序找第一个存在的字体；都找不到就报错，避免静默生成一堆方框。"""
    override = os.environ.get("SUIXINWENDA_PREVIEW_FONT")
    if override:
        return ImageFont.truetype(override, size)
    for path in candidates:
        if Path(path).is_file():
            return ImageFont.truetype(path, size)
    raise SystemExit(f"找不到中文字体，试过：{', '.join(candidates)}（可用 SUIXINWENDA_PREVIEW_FONT 指定）")


def _gradient(theme):
    """竖直渐变背景：比纯色更有层次，又不至于抢字。"""
    top, bottom = theme["bg_top"], theme["bg_bottom"]
    canvas = Image.new("RGB", (WIDTH, HEIGHT), bottom)
    draw = ImageDraw.Draw(canvas)
    for y in range(HEIGHT):
        ratio = y / (HEIGHT - 1)
        color = tuple(round(top[i] + (bottom[i] - top[i]) * ratio) for i in range(3))
        draw.line([(0, y), (WIDTH, y)], fill=color)
    return canvas


def _glow(canvas, theme):
    """右上角一团强调色柔光：让卡片有方向感，不至于平。"""
    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(layer).ellipse((880, -240, 1560, 440), fill=theme["glow"])
    return Image.alpha_composite(canvas.convert("RGBA"), layer.filter(ImageFilter.GaussianBlur(140)))


def build(out_path: Path, theme_name: str) -> None:
    theme = THEMES[theme_name]
    logo_path = theme["logo"]
    if not logo_path.is_file():
        raise SystemExit(f"找不到 logo：{logo_path}（先跑 npm run icons）")

    canvas = _glow(_gradient(theme), theme).convert("RGBA")
    draw = ImageDraw.Draw(canvas)

    mark_size = 300
    gap = 80
    bold_76 = _font(FONT_CANDIDATES, 76)
    reg_40 = _font(REGULAR_CANDIDATES, 40)
    reg_30 = _font(REGULAR_CANDIDATES, 30)
    reg_26 = _font(REGULAR_CANDIDATES, 26)
    reg_20 = _font(REGULAR_CANDIDATES, 20)

    # 按内容实际宽度居中：固定左边距时右侧会空出三分之一，卡片缩到信息流尺寸后明显偏左
    tagline = "流式对话 · 跨轮记忆 · 数据不出本机"
    lines = (
        ("随心问答", bold_76),
        ("SuiXinWenDa", reg_30),
        ("本机运行的桌面 AI 客户端", reg_40),
        (tagline, reg_26),
    )
    text_width = max(draw.textlength(text, font=font) for text, font in lines)
    block_width = mark_size + gap + text_width
    start_x = round((WIDTH - block_width) / 2)

    mark = Image.open(logo_path).convert("RGBA").resize((mark_size, mark_size), Image.LANCZOS)
    canvas.alpha_composite(mark, (start_x, (HEIGHT - mark_size) // 2))

    text_x = start_x + mark_size + gap
    # 四行中心间距 62/44/50/56，整体中心落在 HEIGHT/2，与垂直居中的 logo 对齐
    draw.text((text_x, 214), "随心问答", font=bold_76, fill=theme["text_main"], anchor="lm")
    draw.text((text_x, 276), "SuiXinWenDa", font=reg_30, fill=theme["text_sub"], anchor="lm")
    draw.line([(text_x, 320), (text_x + text_width, 320)], fill=theme["line"], width=2)
    draw.text((text_x, 370), "本机运行的桌面 AI 客户端", font=reg_40, fill=theme["text_main"], anchor="lm")
    draw.text((text_x, 426), tagline, font=reg_26, fill=theme["accent"], anchor="lm")
    # 版权行放右下角：与左侧内容块形成对角，避免所有元素挤在左半边
    draw.text(
        (WIDTH - 72, HEIGHT - 56),
        "Windows x64  ·  MIT License",
        font=reg_20,
        fill=theme["text_dim"],
        anchor="rm",
    )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.convert("RGB").save(out_path, format="PNG", optimize=True)
    size_kb = out_path.stat().st_size / 1024
    print(f"[ OK ] 已生成 {out_path}（{WIDTH}x{HEIGHT}，{size_kb:.0f} KB，{theme_name} 主题）")
    print("[ OK ] 上传位置：仓库 Settings → Social preview → Upload image")


def main() -> int:
    parser = argparse.ArgumentParser(description="生成 GitHub 社交预览图")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="输出文件")
    parser.add_argument("--theme", choices=sorted(THEMES), default="light", help="配色主题（默认浅色）")
    args = parser.parse_args()
    build(Path(args.out), args.theme)
    return 0


if __name__ == "__main__":
    sys.exit(main())
