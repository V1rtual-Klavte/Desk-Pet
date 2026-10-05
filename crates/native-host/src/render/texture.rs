//! 图层纹理：素材解码、账目与生命周期（纯逻辑 + 一处 Rust 解码）。
//!
//! 生命周期规则（执行契约 §6.1）：
//! - 只加载当前层列表中**启用**的图层；同一素材路径（规范化文本）只上传一次；
//! - 上传成功后解码得到的 CPU 缓冲交给平台表面（macOS 由 CGImage 的 data provider
//!   持有，Windows 填进 DIB 后丢弃），账本只记尺寸与字节数，不另存像素副本；
//! - 层列表变更时差量收敛：新路径上传、仍被引用的复用、无人引用的释放。
//!
//! 解码集中到统一图片域 [`crate::images::decode`]（契约 §2.1：解码的唯一实现点），
//! 渲染器不再自建格式限制与解码实现；路径仍先过
//! [`crate::paths::AppPaths::validate_file_path`] 的既有校验 —— 渲染器不自建第二份路径规则。
//! 格式集合由图片域嗅探决定（与聊天附件同一集合），解出的 RGBA 在这里转成平台表面
//! 要求的预乘 BGRA。

use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

use super::surface::RenderSurface;
use super::LayerSpec;

/// 已解码的纹理：预乘 BGRA（8bit/通道，长度 = width × height × 4）。
///
/// 预乘是 CoreAnimation（kCGImageAlphaPremultipliedFirst + 32Little）与 GDI AlphaBlend
/// 共同要求的内存布局，两种用途共用同一个转换。
pub struct DecodedTexture {
    pub width: u32,
    pub height: u32,
    pub bgra: Vec<u8>,
}

impl std::fmt::Debug for DecodedTexture {
    /// 手写 Debug：不打印整个像素缓冲（几十万字节），只给尺寸与字节数。
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DecodedTexture")
            .field("width", &self.width)
            .field("height", &self.height)
            .field("bgra_bytes", &self.bgra.len())
            .finish()
    }
}

/// 解码一个图层素材（路径校验 → 图片域解码 → 预乘 BGRA）。
///
/// 解码唯一实现点是 [`crate::images::decode::decode_static`]（含格式嗅探与
/// EXIF 方向处理）；失败按图片域的明确诊断返回，调用方
/// （[`TextureLedger::reconcile`]）把路径与原因一起如实上报。
pub fn decode_asset(path: &Path) -> AppResult<DecodedTexture> {
    let validated = crate::paths::AppPaths::validate_file_path(path)?;
    let bytes = std::fs::read(&validated).map_err(|error| {
        AppError::Io(format!(
            "读取图层素材失败: {}: {error}",
            validated.display()
        ))
    })?;
    let image = crate::images::decode::decode_static(&bytes)?.image;
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 {
        return Err(AppError::Other(format!(
            "图层素材尺寸为空: {}",
            validated.display()
        )));
    }
    Ok(DecodedTexture {
        width,
        height,
        bgra: rgba_to_premultiplied_bgra(image.as_raw()),
    })
}

/// RGBA（直通 alpha）→ 预乘 BGRA，两平台共用。
fn rgba_to_premultiplied_bgra(rgba: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(rgba.len());
    for px in rgba.chunks_exact(4) {
        let (r, g, b, a) = (px[0] as u16, px[1] as u16, px[2] as u16, px[3] as u16);
        // 四舍五入的预乘（与 W0 探针 Windows 侧同一公式），a=255 时保持原值。
        out.push(((b * a + 127) / 255) as u8);
        out.push(((g * a + 127) / 255) as u8);
        out.push(((r * a + 127) / 255) as u8);
        out.push(a as u8);
    }
    out
}

/// 纹理句柄。由账本分配，单调递增；释放后不复用。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TextureId(u64);

impl TextureId {
    /// 仅供本 crate 内构造（账本分配 / 测试）。
    pub(crate) fn new(value: u64) -> Self {
        Self(value)
    }
}

/// 素材复用键：路径的规范化文本。
///
/// Windows 文件系统大小写不敏感，键统一小写；分隔符归一（`\` → `/`）。
/// canonicalize 要碰磁盘且 resolve 是纯函数，所以键只做词法归一 ——
/// 同一文件经不同符号链接/大小写引用时会被视为两张纹理（尽力复用，不做保证）。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct TextureKey(String);

pub fn texture_key(path: &Path) -> TextureKey {
    let mut key = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        key = key.to_lowercase();
    }
    TextureKey(key)
}

/// 一次层列表收敛需要的上传/释放指令（纯账目，不碰磁盘与平台）。
#[derive(Debug)]
pub struct TexturePlan {
    pub uploads: Vec<UploadRequest>,
    pub releases: Vec<TextureId>,
    /// 仍在列表中且已驻留、本轮被复用的路径数。
    pub reused: usize,
}

#[derive(Debug)]
pub struct UploadRequest {
    pub id: TextureId,
    pub key: TextureKey,
    pub path: PathBuf,
}

/// 收敛执行结果；`failures` 里的层本轮不绘制（如实上报，不静默吞掉）。
#[derive(Debug, Default)]
pub struct ReconcileReport {
    pub uploaded: usize,
    pub reused: usize,
    pub released: usize,
    pub failures: Vec<LayerLoadFailure>,
}

#[derive(Debug)]
pub struct LayerLoadFailure {
    pub path: PathBuf,
    pub error: AppError,
}

#[derive(Debug)]
pub(crate) struct ResidentEntry {
    pub id: TextureId,
    pub key: TextureKey,
    pub width: u32,
    pub height: u32,
    pub pixel_bytes: usize,
}

/// 纹理账本：只记「哪些素材正在驻留、多大、给谁用」，不持有像素。
#[derive(Debug, Default)]
pub struct TextureLedger {
    next_id: u64,
    entries: Vec<ResidentEntry>,
}

impl TextureLedger {
    pub fn new() -> Self {
        Self {
            next_id: 1,
            entries: Vec::new(),
        }
    }

    /// 计算收敛计划（纯函数：只比对账目，不碰磁盘）。同一个路径只产生一条上传。
    pub fn resolve(&mut self, layers: &[LayerSpec]) -> TexturePlan {
        // 每个启用层贡献一个复用键；同键只保留首次出现（它携带的路径用于上传）。
        let mut wanted: Vec<(TextureKey, PathBuf)> = Vec::new();
        for layer in layers.iter().filter(|layer| layer.enabled) {
            let key = texture_key(&layer.path);
            if !wanted.iter().any(|(existing, _)| *existing == key) {
                wanted.push((key, layer.path.clone()));
            }
        }

        let mut uploads = Vec::new();
        let mut reused = 0;
        for (key, path) in wanted.iter() {
            if self.entries.iter().any(|entry| entry.key == *key) {
                reused += 1;
            } else {
                let id = TextureId::new(self.next_id);
                self.next_id += 1;
                uploads.push(UploadRequest {
                    id,
                    key: key.clone(),
                    path: path.clone(),
                });
            }
        }

        let releases = self
            .entries
            .iter()
            .filter(|entry| !wanted.iter().any(|(key, _)| entry.key == *key))
            .map(|entry| entry.id)
            .collect();

        TexturePlan {
            uploads,
            releases,
            reused,
        }
    }

    /// 执行收敛计划：先上传（新旧并存，切换期间不空窗），后释放。
    ///
    /// `decode` 是解码接缝：产品传 [`decode_asset`]；测试可以传入不碰磁盘的桩。
    pub fn apply(
        &mut self,
        plan: TexturePlan,
        surface: &mut dyn RenderSurface,
        decode: &mut dyn FnMut(&Path) -> AppResult<DecodedTexture>,
    ) -> ReconcileReport {
        let mut report = ReconcileReport {
            reused: plan.reused,
            ..Default::default()
        };
        for request in plan.uploads {
            match decode(&request.path) {
                Ok(texture) => {
                    let (width, height, pixel_bytes) =
                        (texture.width, texture.height, texture.bgra.len());
                    match surface.upload(request.id, texture) {
                        Ok(()) => {
                            self.entries.push(ResidentEntry {
                                id: request.id,
                                key: request.key,
                                width,
                                height,
                                pixel_bytes,
                            });
                            report.uploaded += 1;
                        }
                        Err(error) => report.failures.push(LayerLoadFailure {
                            path: request.path,
                            error,
                        }),
                    }
                }
                Err(error) => report.failures.push(LayerLoadFailure {
                    path: request.path,
                    error,
                }),
            }
        }
        for id in plan.releases {
            surface.release(id);
            self.entries.retain(|entry| entry.id != id);
            report.released += 1;
        }
        report
    }

    /// resolve + apply 一步完成。
    pub fn reconcile(
        &mut self,
        layers: &[LayerSpec],
        surface: &mut dyn RenderSurface,
        decode: &mut dyn FnMut(&Path) -> AppResult<DecodedTexture>,
    ) -> ReconcileReport {
        let plan = self.resolve(layers);
        self.apply(plan, surface, decode)
    }

    /// 按复用键查找驻留纹理（帧计划组装用）。
    pub(crate) fn lookup(&self, key: &TextureKey) -> Option<&ResidentEntry> {
        self.entries.iter().find(|entry| entry.key == *key)
    }

    /// 驻留纹理数（释放后必须归零）。
    pub fn resident_count(&self) -> usize {
        self.entries.len()
    }

    /// 驻留像素字节（账目口径，不代表平台侧实际内存）。
    pub fn resident_bytes(&self) -> usize {
        self.entries.iter().map(|entry| entry.pixel_bytes).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render::compose::FramePlan;
    use crate::render::surface::RenderSurface;

    /// 记录调用的假表面：不碰任何平台资源，专门验证账目 → 平台指令的映射。
    #[derive(Default)]
    struct RecordingSurface {
        uploads: Vec<(TextureId, u32, u32)>,
        releases: Vec<TextureId>,
        fail_upload: bool,
    }

    impl RenderSurface for RecordingSurface {
        fn upload(&mut self, id: TextureId, texture: DecodedTexture) -> AppResult<()> {
            if self.fail_upload {
                return Err(AppError::Other("桩：上传失败".into()));
            }
            self.uploads.push((id, texture.width, texture.height));
            Ok(())
        }

        fn release(&mut self, id: TextureId) {
            self.releases.push(id);
        }

        fn present(&mut self, _plan: &FramePlan) -> AppResult<()> {
            Ok(())
        }

        fn start_ticks(&mut self, _sink: Box<dyn FnMut() + Send>) -> AppResult<()> {
            Ok(())
        }

        fn stop_ticks(&mut self) -> AppResult<()> {
            Ok(())
        }
    }

    fn layer(path: &str, enabled: bool) -> LayerSpec {
        LayerSpec {
            path: PathBuf::from(path),
            enabled,
            sensitivity: 0.8,
            scale: 1.0,
            offset_x_percent: 0.0,
            offset_y_percent: 0.0,
        }
    }

    /// 不碰磁盘的桩解码：4×4 全透明纹理。
    fn stub_decode(_path: &Path) -> AppResult<DecodedTexture> {
        Ok(DecodedTexture {
            width: 4,
            height: 4,
            bgra: vec![0u8; 4 * 4 * 4],
        })
    }

    #[test]
    fn 同一路径只上传一次_即使出现在多个启用层() {
        let mut ledger = TextureLedger::new();
        let mut surface = RecordingSurface::default();
        let report = ledger.reconcile(
            &[
                layer("/p/a.png", true),
                layer("/p/a.png", true),
                layer("/p/b.png", true),
            ],
            &mut surface,
            &mut stub_decode,
        );
        assert_eq!(report.uploaded, 2, "a.png 只上传一次");
        assert_eq!(surface.uploads.len(), 2);
        assert_eq!(ledger.resident_count(), 2);
        assert_eq!(ledger.resident_bytes(), 2 * 4 * 4 * 4);
    }

    #[test]
    fn 禁用层不建纹理_也不参与复用键() {
        let mut ledger = TextureLedger::new();
        let mut surface = RecordingSurface::default();
        ledger.reconcile(
            &[layer("/p/a.png", false), layer("/p/b.png", true)],
            &mut surface,
            &mut stub_decode,
        );
        assert_eq!(surface.uploads.len(), 1);
        assert_eq!(surface.uploads[0].1, 4);
        assert_eq!(ledger.resident_count(), 1, "只有启用层驻留");
    }

    #[test]
    fn 已驻留路径复用_不重复上传() {
        let mut ledger = TextureLedger::new();
        let mut surface = RecordingSurface::default();
        let layers = vec![layer("/p/a.png", true)];
        ledger.reconcile(&layers, &mut surface, &mut stub_decode);
        let report = ledger.reconcile(&layers, &mut surface, &mut stub_decode);
        assert_eq!(report.uploaded, 0);
        assert_eq!(report.reused, 1);
        assert_eq!(surface.uploads.len(), 1, "第二轮的 resolve 不得再规划上传");
    }

    #[test]
    fn 路径移出层列表后释放_账目归零() {
        let mut ledger = TextureLedger::new();
        let mut surface = RecordingSurface::default();
        ledger.reconcile(
            &[layer("/p/a.png", true), layer("/p/b.png", true)],
            &mut surface,
            &mut stub_decode,
        );
        assert_eq!(ledger.resident_count(), 2);
        let released_id = ledger
            .lookup(&texture_key(Path::new("/p/a.png")))
            .unwrap()
            .id;

        let report = ledger.reconcile(&[layer("/p/b.png", true)], &mut surface, &mut stub_decode);
        assert_eq!(report.released, 1);
        assert_eq!(surface.releases, vec![released_id]);
        assert_eq!(ledger.resident_count(), 1);

        let report = ledger.reconcile(&[], &mut surface, &mut stub_decode);
        assert_eq!(report.released, 1);
        assert_eq!(ledger.resident_count(), 0);
        assert_eq!(ledger.resident_bytes(), 0, "释放后字节账目归零");
    }

    #[test]
    fn 仍被引用的路径在收敛时不释放() {
        let mut ledger = TextureLedger::new();
        let mut surface = RecordingSurface::default();
        ledger.reconcile(
            &[layer("/p/a.png", true), layer("/p/a.png", true)],
            &mut surface,
            &mut stub_decode,
        );
        let report = ledger.reconcile(
            &[layer("/p/a.png", true), layer("/p/c.png", true)],
            &mut surface,
            &mut stub_decode,
        );
        assert_eq!(report.released, 0, "a.png 仍被第一层引用");
        assert_eq!(report.uploaded, 1, "c.png 新上传");
        assert_eq!(ledger.resident_count(), 2);
    }

    #[test]
    fn 解码或上传失败不驻留且如实上报() {
        let mut ledger = TextureLedger::new();
        let mut surface = RecordingSurface::default();
        surface.fail_upload = true;
        let report = ledger.reconcile(&[layer("/p/a.png", true)], &mut surface, &mut stub_decode);
        assert_eq!(report.uploaded, 0);
        assert_eq!(report.failures.len(), 1);
        assert_eq!(ledger.resident_count(), 0, "失败的上传不得进账本");

        // 解码失败（桩直接报错）同样只进失败清单
        let mut decode_error = |_path: &Path| -> AppResult<DecodedTexture> {
            Err(AppError::Other("桩：解码失败".into()))
        };
        let report = ledger.reconcile(&[layer("/p/a.png", true)], &mut surface, &mut decode_error);
        assert_eq!(report.failures.len(), 1);
        assert_eq!(ledger.resident_count(), 0);
    }

    #[test]
    fn 预乘通道序_通道值不超过透明度() {
        let rgba = [
            255, 128, 64, 255, // 不透明：保持原值，BGR 序
            255, 0, 0, 0, // 全透明：RGB 归零
            200, 100, 50, 128, // 半透明：四舍五入预乘
            0, 0, 0, 0, // 全黑全透明
        ];
        let bgra = rgba_to_premultiplied_bgra(&rgba);
        assert_eq!(&bgra[0..4], &[64, 128, 255, 255]);
        assert_eq!(&bgra[4..8], &[0, 0, 0, 0]);
        let a = 128u16;
        assert_eq!(
            &bgra[8..12],
            &[
                ((50 * a + 127) / 255) as u8,
                ((100 * a + 127) / 255) as u8,
                ((200 * a + 127) / 255) as u8,
                128
            ]
        );
        assert_eq!(&bgra[12..16], &[0, 0, 0, 0]);
    }

    /// 真实解码路径（仓库现成小 PNG，内联进测试二进制）：尺寸与预乘不变量。
    #[test]
    fn 真实图片解码_尺寸与预乘不变量() {
        const FIXTURE: &[u8] = include_bytes!(
            "../../../../resources/defaults/profiles/sugar-pink/materials/L2/body.png"
        );
        let dir = std::env::temp_dir().join(format!(
            "deskpet-render-decode-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("fixture.png");
        std::fs::write(&path, FIXTURE).unwrap();

        let decoded = decode_asset(&path).unwrap();
        assert!(decoded.width > 0 && decoded.height > 0);
        assert_eq!(
            decoded.bgra.len(),
            decoded.width as usize * decoded.height as usize * 4
        );
        // 预乘不变量：每个通道不得超过 alpha。
        for px in decoded.bgra.chunks_exact(4) {
            let a = px[3];
            assert!(
                px[0] <= a && px[1] <= a && px[2] <= a,
                "预乘后通道必须 ≤ alpha"
            );
        }

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn 不存在的素材路径被既有路径校验拒绝() {
        let missing = std::env::temp_dir().join("deskpet-render-missing/never.png");
        let error = decode_asset(&missing).unwrap_err();
        assert!(
            matches!(error, AppError::PathNotFound(_)),
            "应走 paths 的既有校验，而不是自建规则"
        );
    }
}
