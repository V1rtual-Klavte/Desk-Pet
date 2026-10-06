# README 演示素材

根 [README](../../README.md) 顶部的三张演示动图（动画 WebP，720px 宽 · 约 52fps · 每帧 19ms）。

| 文件 | 内容 |
|---|---|
| `theme-1.webp` | 主题一（浅色）× 角色对话 |
| `theme-2.webp` | 主题二（明亮）× 角色对话 |
| `theme-3.webp` | 主题三（暗色）× 角色对话 |

源录屏（`.mov`）不入库；需要重出时：

```bash
# ① 抽帧：52.63fps（=每帧 19ms）、宽 720
mkdir -p /tmp/frames
ffmpeg -i 源录屏.mov -vf "fps=52.63,scale=720:-1:flags=lanczos" /tmp/frames/%04d.png

# ② 合成动画 WebP：-d 19 = 每帧 19ms、-q 88 画质、-m 6 最省档
img2webp -loop 0 -lossy -d 19 -q 88 -m 6 -o theme-1.webp /tmp/frames/*.png
```

- **为什么不用 GIF**：GIF 帧延迟小于 20ms 会被浏览器强制按 100ms 播放（60fps 反而卡成幻灯片），同画质体积约为 WebP 的 3 倍；WebP 的帧时长为毫秒级、浏览器按实际值播放。
- **档位调节**：更小 → `-q 80` 或缩到 560px；更清晰 → `-q 90` 或 900px（体积约 ×1.4）。
- **验收方法**：用浏览器直接打开 webp 目检（`webpmux -get frame N` 抽出来的是未合成的透明碎块，别误判为坏图）。
