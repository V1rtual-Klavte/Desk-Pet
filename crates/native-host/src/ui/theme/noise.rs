//! 可平铺的分形噪声（fBm value noise）。
//!
//! 设计稿的四种纹理本来是 SVG `feTurbulence` 位图；原生侧没有 SVG 光栅器，
//! 改为在运行时直接算像素 —— 磁盘零资源，内存只留当前主题那一张。
//!
//! **可平铺**：设计稿用 `stitchTiles='stitch'`，这里用等价做法 —— 把每层的格点
//! 数（`频率 × 边长`）取整，采样时对格点数取模，于是左右/上下边界天然对齐。
//! 这是 Verdigris 那道「纹理接缝」的根治办法（原设计稿是低频纹理在小 SVG 上
//! 平铺，相邻块对不上；现在频率与边长一比一绑定，不存这个可能）。

/// 一层噪声的格点哈希：`(ix, iy, octave, seed)` → `[0,1)`。
///
/// 取模在调用方做（那里才知道格点数），这里只负责把坐标打散。
#[inline]
fn lattice(ix: i64, iy: i64, octave: u32, seed: u32) -> f32 {
    let mut h = (ix as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15)
        ^ (iy as u64).wrapping_mul(0xC2B2_AE3D_27D4_EB4F)
        ^ (octave as u64).wrapping_mul(0x1656_67B1_9E37_79F9)
        ^ (seed as u64).wrapping_mul(0x27D4_EB2F_1656_67B1);
    // 收尾混合（splitmix64 的最后一步）：让低位也充分参与。
    h ^= h >> 30;
    h = h.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    h ^= h >> 27;
    h = h.wrapping_mul(0x94D0_49BB_1331_11EB);
    h ^= h >> 31;
    (h >> 40) as f32 / (1u32 << 24) as f32
}

/// 平滑插值权重（Perlin 的 6t⁵-15t⁴+10t³，二阶连续）。
#[inline]
fn smooth(t: f32) -> f32 {
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

/// 单层可平铺 value noise。`cells` 是这一层的格点数（整数 ⇒ 可平铺）。
#[inline]
fn value_noise(x: f32, y: f32, cells_x: i64, cells_y: i64, octave: u32, seed: u32) -> f32 {
    let fx = x * cells_x as f32;
    let fy = y * cells_y as f32;
    let ix = fx.floor();
    let iy = fy.floor();
    let tx = smooth(fx - ix);
    let ty = smooth(fy - iy);
    let ix = ix as i64;
    let iy = iy as i64;

    // 取模实现环绕：格点表首尾相接，平铺时边界处不会有断崖。
    let wrap = |v: i64, n: i64| -> i64 { ((v % n) + n) % n };
    let x0 = wrap(ix, cells_x);
    let x1 = wrap(ix + 1, cells_x);
    let y0 = wrap(iy, cells_y);
    let y1 = wrap(iy + 1, cells_y);

    let n00 = lattice(x0, y0, octave, seed);
    let n10 = lattice(x1, y0, octave, seed);
    let n01 = lattice(x0, y1, octave, seed);
    let n11 = lattice(x1, y1, octave, seed);

    let top = n00 + (n10 - n00) * tx;
    let bottom = n01 + (n11 - n01) * tx;
    top + (bottom - top) * ty
}

/// 分形叠加（fBm）：每层频率翻倍、振幅减半，与 SVG `fractalNoise` 同款。
///
/// 返回 `[0,1]`。`freq` 是「每像素的周期数」（对应 SVG 的 `baseFrequency`），
/// `size` 是输出贴图边长 —— 两者相乘取整得到格点数，这就是可平铺的保证。
#[inline]
fn fbm(x: f32, y: f32, freq_x: f32, freq_y: f32, size: u32, octaves: u32, seed: u32) -> f32 {
    let mut sum = 0.0f32;
    let mut norm = 0.0f32;
    let mut amp = 1.0f32;
    for o in 0..octaves {
        let scale = (1u32 << o) as f32;
        // 格点数：频率 × 边长 × 2^o，至少 1 格，避免退化成常数。
        let cells_x = ((freq_x * size as f32 * scale).round() as i64).max(1);
        let cells_y = ((freq_y * size as f32 * scale).round() as i64).max(1);
        sum += amp * value_noise(x, y, cells_x, cells_y, o, seed);
        norm += amp;
        amp *= 0.5;
    }
    if norm > 0.0 {
        sum / norm
    } else {
        0.0
    }
}

/// 一张 RGBA8 贴图（左上原点，逐行紧凑排列）。
pub struct Bitmap {
    pub width: u32,
    pub height: u32,
    /// 长度 = `width × height × 4`。
    pub pixels: Vec<u8>,
}

/// 按 fBm 生成一张常数色、alpha 随噪声起伏的贴图。
///
/// 这正是设计稿四种 `feTurbulence` 的公共形状：`feColorMatrix` 把 RGB 压成常数、
/// alpha 取 `scale × 噪声`（`--fiber` 是黑色 alpha .5、`--brush` 是 (0.5,0.52,0.56)
/// alpha .5、`--verdigris` 是 (0.25,0.52,0.44) alpha .5）。所以一个生成器通吃，
/// 差别只在配方参数。
pub fn generate(
    size: u32,
    freq_x: f32,
    freq_y: f32,
    octaves: u32,
    color: [f32; 3],
    alpha_scale: f32,
    seed: u32,
) -> Bitmap {
    let mut pixels = vec![0u8; (size as usize) * (size as usize) * 4];
    let inv = 1.0 / size as f32;
    for y in 0..size {
        for x in 0..size {
            let n = fbm(
                x as f32 * inv,
                y as f32 * inv,
                freq_x,
                freq_y,
                size,
                octaves,
                seed,
            );
            let i = ((y as usize) * (size as usize) + (x as usize)) * 4;
            pixels[i] = (color[0].clamp(0.0, 1.0) * 255.0) as u8;
            pixels[i + 1] = (color[1].clamp(0.0, 1.0) * 255.0) as u8;
            pixels[i + 2] = (color[2].clamp(0.0, 1.0) * 255.0) as u8;
            pixels[i + 3] = ((n * alpha_scale).clamp(0.0, 1.0) * 255.0) as u8;
        }
    }
    Bitmap {
        width: size,
        height: size,
        pixels,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 同一坐标必然同值（生成结果可复现，不是每次启动都换一张脸）。
    #[test]
    fn 噪声可复现() {
        let a = generate(32, 0.55, 0.9, 2, [0.0, 0.0, 0.0], 0.5, 7);
        let b = generate(32, 0.55, 0.9, 2, [0.0, 0.0, 0.0], 0.5, 7);
        assert_eq!(a.pixels, b.pixels);
    }

    /// 不同种子应该给出不同贴图（否则三套主题会长一样）。
    #[test]
    fn 换种子换纹理() {
        let a = generate(32, 0.55, 0.9, 2, [0.0, 0.0, 0.0], 0.5, 1);
        let b = generate(32, 0.55, 0.9, 2, [0.0, 0.0, 0.0], 0.5, 2);
        assert_ne!(a.pixels, b.pixels);
    }

    /// 可平铺：左右相邻列在环绕处的差值，应与内部相邻列的差值同量级
    /// （不要求相等 —— 噪声本来就有起伏；要求的是**没有断崖**）。
    #[test]
    fn 左右边界无接缝() {
        let n = 256;
        let b = generate(n, 0.55, 0.9, 3, [0.0, 0.0, 0.0], 1.0, 3);
        let alpha =
            |x: u32, y: u32| b.pixels[((y as usize) * (n as usize) + (x as usize)) * 4 + 3] as i32;

        let mut seam = 0i64;
        let mut interior = 0i64;
        for y in 0..n {
            seam += (alpha(0, y) - alpha(n - 1, y)).abs() as i64;
            interior += (alpha(1, y) - alpha(0, y)).abs() as i64;
        }
        // 接缝处的平均落差不得超过内部相邻列落差的 3 倍。
        assert!(
            seam <= interior * 3 + 64,
            "左右接缝落差 {seam} 远大于内部落差 {interior}"
        );
    }

    /// 上下边界同理。
    #[test]
    fn 上下边界无接缝() {
        let n = 256;
        let b = generate(n, 0.55, 0.9, 3, [0.0, 0.0, 0.0], 1.0, 3);
        let alpha =
            |x: u32, y: u32| b.pixels[((y as usize) * (n as usize) + (x as usize)) * 4 + 3] as i32;

        let mut seam = 0i64;
        let mut interior = 0i64;
        for x in 0..n {
            seam += (alpha(x, 0) - alpha(x, n - 1)).abs() as i64;
            interior += (alpha(x, 1) - alpha(x, 0)).abs() as i64;
        }
        assert!(
            seam <= interior * 3 + 64,
            "上下接缝落差 {seam} 远大于内部落差 {interior}"
        );
    }

    /// RGB 是常数（设计稿的 `feColorMatrix` 就是把 RGB 压成常数）。
    #[test]
    fn 颜色是常数只有透明度起伏() {
        let b = generate(16, 0.5, 0.5, 2, [0.5, 0.52, 0.56], 0.5, 4);
        for px in b.pixels.chunks_exact(4) {
            assert_eq!(px[0], (0.5f32 * 255.0) as u8);
            assert_eq!(px[1], (0.52f32 * 255.0) as u8);
            assert_eq!(px[2], (0.56f32 * 255.0) as u8);
        }
        let alphas: Vec<u8> = b.pixels.chunks_exact(4).map(|p| p[3]).collect();
        assert!(alphas.iter().any(|&a| a > 0), "alpha 全零说明没算出来");
        assert!(alphas.iter().any(|&a| a < 128), "alpha 全满说明没起伏");
    }
}
