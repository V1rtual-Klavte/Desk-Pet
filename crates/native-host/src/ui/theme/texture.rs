//! 主题纹理：配方 + 按需生成 + 只留当前主题的驻留。
//!
//! 配方读数照 `docs/history/design/theme-candidates.html` 的四张 SVG `feTurbulence`。
//! 查证过实际被引用的只有两张：`--grain`（舞台与面板的细颗粒叠加）与
//! `--verdigris`（铜绿面板斑块）。设计稿里另外定义的 `--fiber` / `--brush`
//! **在图上零引用**，所以这里不生成它们 —— 不为没有画面的东西付内存。
//!
//! 驻留纪律：只有**当前主题**用到的纹理才会被算出来并留在账上；切主题时旧贴图
//! 连同像素一起释放。同一时刻最多一张大图。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use super::noise::{self, Bitmap};

/// 纹理标识。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Tex {
    /// 细颗粒：三套主题在舞台与面板上叠加同一张（只是透明度不同）。
    Grain,
    /// 铜绿斑块：低频有机噪声，**整块铺满不平铺**（设计稿踩过的接缝坑）。
    Verdigris,
}

impl Tex {
    /// 配方：`(边长, 每像素周期 X, 每像素周期 Y, 层数, 常数 RGB, alpha 系数, 种子)`。
    ///
    /// 与 SVG 的对应：周期 = `baseFrequency`，层数 = `numOctaves`，
    /// 常数 RGB + alpha 系数 = `feColorMatrix` 的后四行。
    const fn recipe(self) -> (u32, f32, f32, u32, [f32; 3], f32, u32) {
        match self {
            // <feTurbulence baseFrequency='.9' numOctaves='4'/> + 全通道彩色输出。
            // 原生侧用中性灰代替彩色噪声：它只在 2.8% / 5% 的叠加里出现，
            // 这个透明度下彩噪与灰噪肉眼无差，但灰噪是单通道语义、更好合成。
            Tex::Grain => (140, 0.9, 0.9, 4, [0.5, 0.5, 0.5], 0.5, 0x6772_6169),
            // <feTurbulence baseFrequency='.011' numOctaves='4'/> +
            // <feColorMatrix '0 0 0 0 .25 / 0 0 0 0 .52 / 0 0 0 0 .44 / 0 0 0 .5 0'/>
            // 边长取 900：`.011 × 900 = 9.9 → 10 格`，格点数取整即可平铺，
            // 同时 900 已大于面板尺寸，实际不会出现重复的斑块。
            Tex::Verdigris => (900, 0.011, 0.011, 4, [0.25, 0.52, 0.44], 0.5, 0x7665_7264),
        }
    }

    /// 生成贴图（纯函数，不碰缓存）。测试与平台层都用它。
    pub fn render(self) -> Bitmap {
        let (size, fx, fy, octaves, color, alpha, seed) = self.recipe();
        noise::generate(size, fx, fy, octaves, color, alpha, seed)
    }

    /// 边长（平台层算铺贴次数用）。
    pub fn size(self) -> u32 {
        self.recipe().0
    }
}

/// 纹理缓存：算过的贴图留在这里，进程内共享。
///
/// `clear_except` 是「只留选中主题」的落点 —— 切主题时把不属于新主题的贴图连同
/// 像素一起丢掉，不让三套主题的纹理同时驻留。
#[derive(Default)]
pub struct TextureCache {
    map: HashMap<Tex, Arc<Bitmap>>,
}

impl TextureCache {
    /// 取一张贴图，没有就算（首次调用会花掉生成时间）。
    pub fn get(&mut self, tex: Tex) -> Arc<Bitmap> {
        if let Some(hit) = self.map.get(&tex) {
            return Arc::clone(hit);
        }
        let bitmap = Arc::new(tex.render());
        self.map.insert(tex, Arc::clone(&bitmap));
        bitmap
    }

    /// 只留下 `keep` 里的贴图，其余释放。返回被释放的字节数。
    pub fn clear_except(&mut self, keep: &[Tex]) -> usize {
        let mut freed = 0usize;
        self.map.retain(|tex, bitmap| {
            if keep.contains(tex) {
                true
            } else {
                freed += bitmap.pixels.len();
                false
            }
        });
        freed
    }

    /// 当前驻留像素字节（诊断口径，与 `RendererStats::resident_bytes` 同款）。
    pub fn resident_bytes(&self) -> usize {
        self.map.values().map(|b| b.pixels.len()).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

/// 进程级缓存（主题是全局单例，纹理也随它全局一份）。
fn cache() -> &'static Mutex<TextureCache> {
    static CACHE: OnceLock<Mutex<TextureCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(TextureCache::default()))
}

/// 取一张贴图（全局缓存的便捷入口）。
pub fn get(tex: Tex) -> Arc<Bitmap> {
    let mut guard = cache().lock().unwrap_or_else(|e| e.into_inner());
    guard.get(tex)
}

/// 只留 `keep`，释放其余。切主题时调用。
pub fn retain_only(keep: &[Tex]) -> usize {
    let mut guard = cache().lock().unwrap_or_else(|e| e.into_inner());
    guard.clear_except(keep)
}

/// 当前驻留字节（诊断用）。
pub fn resident_bytes() -> usize {
    let guard = cache().lock().unwrap_or_else(|e| e.into_inner());
    guard.resident_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 配方边长与设计稿一致() {
        assert_eq!(Tex::Grain.size(), 140);
        assert_eq!(Tex::Verdigris.size(), 900);
    }

    /// 默认主题（拉丝）不用 Verdigris —— 切到它之前不该为它掏内存。
    #[test]
    fn 只留选中的纹理() {
        let mut cache = TextureCache::default();
        cache.get(Tex::Verdigris);
        cache.get(Tex::Grain);
        assert!(cache.resident_bytes() > 900 * 900 * 4 - 1);

        let freed = cache.clear_except(&[Tex::Grain]);
        assert_eq!(freed, 900 * 900 * 4, "释放的应正好是 Verdigris 那张");
        assert!(cache.resident_bytes() < 140 * 140 * 4 + 1);
    }

    #[test]
    fn 重复取同一张不重复生成() {
        let mut cache = TextureCache::default();
        let a = cache.get(Tex::Grain);
        let b = cache.get(Tex::Grain);
        assert!(Arc::ptr_eq(&a, &b), "第二次应命中缓存而不是重算");
    }

    /// 纹理是常数色 + 透明度起伏（与 SVG 的 feColorMatrix 语义一致）。
    #[test]
    fn 铜绿是墨绿色() {
        let b = Tex::Verdigris.render();
        assert_eq!(b.width, 900);
        assert_eq!(b.height, 900);
        let first = &b.pixels[0..4];
        assert_eq!(
            &first[0..3],
            &[
                (0.25f32 * 255.0) as u8,
                (0.52f32 * 255.0) as u8,
                (0.44f32 * 255.0) as u8
            ]
        );
    }
}
