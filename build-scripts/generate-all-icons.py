"""
FreeMyDisk Comprehensive Icon & Asset Generator
Generates all icon sizes, formats, and branding assets required by FreeMyDisk:
- Square masters (1024x1024, 512x512)
- Frontend assets (public/logo.png, public/icon.png, src/assets/logo.png)
- Favicons (public/favicon.ico multi-resolution, 16x16, 32x32, apple-touch-icon 180x180)
- Tauri desktop & mobile icons (via pnpm tauri icon + high-DPI multi-frame ICO)
- NSIS installer graphics (header 150x57 BMP, sidebar 164x314 BMP)
"""

import os
import subprocess
from PIL import Image, ImageDraw, ImageFont

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SOURCE_ICON_PATH = os.path.join(ROOT_DIR, "FMD_Icon.png")

def make_square_master(src_img: Image.Image, size: int, padding: int) -> Image.Image:
    """Center and scale image inside a square canvas with transparent background."""
    target_max = size - (padding * 2)
    scale = min(target_max / src_img.width, target_max / src_img.height)
    new_w = int(round(src_img.width * scale))
    new_h = int(round(src_img.height * scale))
    
    resized = src_img.resize((new_w, new_h), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    paste_x = (size - new_w) // 2
    paste_y = (size - new_h) // 2
    canvas.paste(resized, (paste_x, paste_y), resized)
    return canvas

def generate_multi_ico(src_1024: Image.Image, output_path: str, sizes: list):
    """Generate multi-resolution ICO file with clean downsampling."""
    frames = []
    for s in sizes:
        resized = src_1024.resize((s, s), Image.Resampling.LANCZOS)
        frames.append(resized)
    # Save the largest as base and provide sizes
    frames[-1].save(output_path, format="ICO", sizes=[(s, s) for s in sizes])
    print(f"Generated multi-resolution ICO ({len(sizes)} sizes: {sizes}) -> {output_path}")

def generate_nsis_header(src_img: Image.Image, output_path: str):
    """NSIS header bitmap: 150x57 BMP with white background and icon on the right."""
    w, h = 150, 57
    header = Image.new("RGB", (w, h), (255, 255, 255))
    icon_h = 48
    icon_scale = icon_h / src_img.height
    icon_w = int(round(src_img.width * icon_scale))
    resized = src_img.resize((icon_w, icon_h), Image.Resampling.LANCZOS)
    
    paste_x = w - icon_w - 8
    paste_y = (h - icon_h) // 2
    header.paste(resized, (paste_x, paste_y), resized)
    header.save(output_path, format="BMP")
    print(f"Generated NSIS Header -> {output_path}")

def generate_nsis_sidebar(src_img: Image.Image, output_path: str):
    """NSIS sidebar bitmap: 164x314 BMP with sleek dark gradient, logo, and typography."""
    w, h = 164, 314
    # Create vertical gradient from #0f172a (15, 23, 42) to #1e3a8a (30, 58, 138)
    top_color = (15, 23, 42)
    bot_color = (30, 58, 138)
    sidebar = Image.new("RGB", (w, h))
    for y in range(h):
        ratio = y / float(h - 1)
        r = int(top_color[0] + (bot_color[0] - top_color[0]) * ratio)
        g = int(top_color[1] + (bot_color[1] - top_color[1]) * ratio)
        b = int(top_color[2] + (bot_color[2] - top_color[2]) * ratio)
        for x in range(w):
            sidebar.putpixel((x, y), (r, g, b))
            
    # Draw logo
    logo_max = 96
    scale = min(logo_max / src_img.width, logo_max / src_img.height)
    logo_w = int(round(src_img.width * scale))
    logo_h = int(round(src_img.height * scale))
    logo_resized = src_img.resize((logo_w, logo_h), Image.Resampling.LANCZOS)
    
    logo_x = (w - logo_w) // 2
    logo_y = 44
    sidebar.paste(logo_resized, (logo_x, logo_y), logo_resized)
    
    draw = ImageDraw.Draw(sidebar)
    
    # Try loading clean font or fallback to default
    try:
        font_title = ImageFont.truetype("segoeui.ttf", 17)
        font_sub = ImageFont.truetype("segoeui.ttf", 10)
    except Exception:
        try:
            font_title = ImageFont.truetype("arial.ttf", 16)
            font_sub = ImageFont.truetype("arial.ttf", 10)
        except Exception:
            font_title = ImageFont.load_default()
            font_sub = ImageFont.load_default()
            
    # Title "FreeMyDisk"
    title_text = "FreeMyDisk"
    t_bbox = draw.textbbox((0, 0), title_text, font=font_title)
    t_w = t_bbox[2] - t_bbox[0]
    t_x = (w - t_w) // 2
    t_y = logo_y + logo_h + 16
    draw.text((t_x, t_y), title_text, fill=(255, 255, 255), font=font_title)
    
    # Subtitle "Disk Intelligence & Storage Cleaner" (wrapped)
    sub1 = "Disk Intelligence"
    sub2 = "& Storage Cleaner"
    s1_bbox = draw.textbbox((0, 0), sub1, font=font_sub)
    s2_bbox = draw.textbbox((0, 0), sub2, font=font_sub)
    s1_w = s1_bbox[2] - s1_bbox[0]
    s2_w = s2_bbox[2] - s2_bbox[0]
    
    s_y = t_y + 26
    draw.text(((w - s1_w) // 2, s_y), sub1, fill=(147, 197, 253), font=font_sub)
    draw.text(((w - s2_w) // 2, s_y + 14), sub2, fill=(147, 197, 253), font=font_sub)
    
    sidebar.save(output_path, format="BMP")
    print(f"Generated NSIS Sidebar -> {output_path}")

def main():
    if not os.path.exists(SOURCE_ICON_PATH):
        raise FileNotFoundError(f"Source icon not found at {SOURCE_ICON_PATH}")
        
    print(f"Opening source logo: {SOURCE_ICON_PATH}")
    src = Image.open(SOURCE_ICON_PATH).convert("RGBA")
    print(f"Source image loaded: {src.size}, mode: {src.mode}")
    
    # 1. Generate master square 1024x1024 and 512x512
    square_1024 = make_square_master(src, 1024, padding=48)
    square_512 = make_square_master(src, 512, padding=24)
    
    master_1024_path = os.path.join(ROOT_DIR, "build-scripts", "freemydisk-square-1024.png")
    master_512_path = os.path.join(ROOT_DIR, "build-scripts", "freemydisk-square-512.png")
    square_1024.save(master_1024_path, "PNG")
    square_512.save(master_512_path, "PNG")
    print(f"Saved master squares -> {master_1024_path}, {master_512_path}")
    
    # 2. Web & Frontend Assets
    public_logo = os.path.join(ROOT_DIR, "public", "logo.png")
    public_icon = os.path.join(ROOT_DIR, "public", "icon.png")
    assets_logo = os.path.join(ROOT_DIR, "src", "assets", "logo.png")
    
    # Tightly-framed 512x512 for crisp UI representation (TitleBar, Sidebar, Settings)
    ui_square_512 = make_square_master(src, 512, padding=16)
    ui_square_512.save(public_logo, "PNG")
    ui_square_512.save(public_icon, "PNG")
    os.makedirs(os.path.dirname(assets_logo), exist_ok=True)
    ui_square_512.save(assets_logo, "PNG")
    print("Saved public/logo.png, public/icon.png, and src/assets/logo.png")
    
    # 3. Web Favicons (PNGs & Multi-res ICO)
    fav_16 = os.path.join(ROOT_DIR, "public", "favicon-16x16.png")
    fav_32 = os.path.join(ROOT_DIR, "public", "favicon-32x32.png")
    apple_touch = os.path.join(ROOT_DIR, "public", "apple-touch-icon.png")
    fav_ico = os.path.join(ROOT_DIR, "public", "favicon.ico")
    
    make_square_master(src, 16, padding=1).save(fav_16, "PNG")
    make_square_master(src, 32, padding=2).save(fav_32, "PNG")
    make_square_master(src, 180, padding=12).save(apple_touch, "PNG")
    
    ico_sizes = [16, 20, 24, 32, 48, 64, 128, 256]
    generate_multi_ico(square_1024, fav_ico, ico_sizes)
    
    # 4. NSIS Bitmaps
    nsis_dir = os.path.join(ROOT_DIR, "src-tauri", "icons", "nsis")
    os.makedirs(nsis_dir, exist_ok=True)
    generate_nsis_header(src, os.path.join(nsis_dir, "installer-header.bmp"))
    generate_nsis_sidebar(src, os.path.join(nsis_dir, "installer-sidebar.bmp"))
    
    # 5. Run Tauri icon tool to generate all Tauri, iOS, Android, and Windows Store sizes
    print("Executing 'pnpm tauri icon' using master 1024x1024...")
    icons_dir = os.path.join(ROOT_DIR, "src-tauri", "icons")
    cmd = ["cmd", "/c", "pnpm", "tauri", "icon", master_1024_path, "-o", icons_dir]
    res = subprocess.run(cmd, cwd=ROOT_DIR, capture_output=True, text=True)
    print(res.stdout)
    if res.returncode != 0:
        print(res.stderr)
        raise RuntimeError(f"tauri icon failed with code {res.returncode}")
        
    # 6. Enhance src-tauri/icons/icon.ico with multi-resolution frames (16, 20, 24, 32, 40, 48, 64, 128, 256)
    tauri_ico = os.path.join(icons_dir, "icon.ico")
    windows_ico_sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    generate_multi_ico(square_1024, tauri_ico, windows_ico_sizes)
    
    print("\nAll FreeMyDisk icons successfully generated in all sizes and formats!")

if __name__ == "__main__":
    main()
