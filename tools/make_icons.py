"""生成插件图标：蓝色圆角方块 + 白色右箭头 + 三个圆点（代表「三次空格」）。"""

from PIL import Image, ImageDraw

BLUE = (24, 95, 165, 255)
WHITE = (255, 255, 255, 255)
SS = 8  # 超采样倍数，用于抗锯齿


def make_icon(size: int, path: str) -> None:
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 圆角方块底
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=BLUE)

    # 右箭头（横杆 + 箭头）
    half = int(s * 0.058)
    y = int(s * 0.375)
    x0, x1 = int(s * 0.235), int(s * 0.60)
    d.rounded_rectangle([x0, y - half, x1, y + half], radius=half, fill=WHITE)

    head = int(s * 0.125)
    d.polygon(
        [
            (int(s * 0.585), y - head),
            (int(s * 0.795), y),
            (int(s * 0.585), y + head),
        ],
        fill=WHITE,
    )

    # 三个圆点
    dy = int(s * 0.685)
    dr = int(s * 0.062)
    for cx in (0.285, 0.5, 0.715):
        x = int(s * cx)
        d.ellipse([x - dr, dy - dr, x + dr, dy + dr], fill=WHITE)

    img = img.resize((size, size), Image.LANCZOS)
    img.save(path, "PNG")
    print(f"generated {path} ({size}x{size})")


if __name__ == "__main__":
    import os

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(root, "icons")
    os.makedirs(out_dir, exist_ok=True)
    for size in (16, 32, 48, 128):
        make_icon(size, os.path.join(out_dir, f"icon{size}.png"))
