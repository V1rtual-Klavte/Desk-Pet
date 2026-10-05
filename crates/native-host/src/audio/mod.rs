//! 宿主侧音效端口。唯一音色来源是 Node 音频域生成的 WAV；Native 只缓存并播放。
//!
//! 1. 宿主侧唯一入口 trait [`AudioPort`]（当前 UI 只用到呼出/收回/欢迎三个事件）；
//! 2. 事件语义 [`AudioCue`]（呼出/收回/启动欢迎 —— 对应 `playEventSound` 的同一批 key）；
//! 3. 平台实现：macOS 走 `NSSound`、Windows 用独立 winmm waveOut voice 支持重叠播放。

use crate::error::{AppError, AppResult};
use std::sync::{Arc, Mutex, MutexGuard};

/// 宿主播放的音效事件（与 `playEventSound` 的窗口相关 key 对应）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AudioCue {
    /// 启动欢迎（对应 TS key `welcome`）。
    Welcome,
    /// 弹窗出现（对应 TS key `popup`）。
    Popup,
    /// 窗口收回（对应 TS key `retract`）。
    Retract,
}

/// 宿主音效接口。实现必须是线程安全的：调用点可能来自 UI 主线程，实现自行决定
/// 是否转发到音频线程。
pub trait AudioPort: Send + Sync {
    fn play(&self, cue: AudioCue) -> AppResult<()>;
    fn play_wav(&self, wav: &[u8]) -> AppResult<()>;
    fn configure_cues(
        &self,
        welcome: Option<Vec<u8>>,
        popup: Option<Vec<u8>>,
        retract: Option<Vec<u8>>,
    ) -> AppResult<()>;
}

/// 创建可直接注入 [`crate::ui::ServiceRequest`] 的平台音效端口。
pub fn native_audio(ui: crate::ui::UiHandle) -> Arc<NativeAudio> {
    Arc::new(NativeAudio {
        ui,
        cues: Mutex::new(AudioClips::default()),
    })
}

pub struct NativeAudio {
    ui: crate::ui::UiHandle,
    cues: Mutex<AudioClips>,
}

#[derive(Default)]
struct AudioClips {
    welcome: Option<Arc<[u8]>>,
    popup: Option<Arc<[u8]>>,
    retract: Option<Arc<[u8]>>,
}

impl NativeAudio {
    fn lock(&self) -> MutexGuard<'_, AudioClips> {
        self.cues.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn configured(&self, cue: AudioCue) -> Option<Arc<[u8]>> {
        let clips = self.lock();
        match cue {
            AudioCue::Welcome => clips.welcome.clone(),
            AudioCue::Popup => clips.popup.clone(),
            AudioCue::Retract => clips.retract.clone(),
        }
    }
}

fn validate_wav(wav: &[u8]) -> AppResult<()> {
    const MAX_WAV_BYTES: usize = 4 * 1024 * 1024;
    if wav.len() < 44 || wav.len() > MAX_WAV_BYTES || &wav[..4] != b"RIFF" || &wav[8..12] != b"WAVE"
    {
        return Err(AppError::Config(
            "Native 音效不是有效或有界 WAV 数据".into(),
        ));
    }
    let riff_len = u32::from_le_bytes(wav[4..8].try_into().expect("WAV header checked")) as usize;
    if riff_len.checked_add(8) != Some(wav.len()) {
        return Err(AppError::Config(
            "Native 音效 WAV 长度与 RIFF 头不符".into(),
        ));
    }
    Ok(())
}

impl AudioPort for NativeAudio {
    fn play(&self, cue: AudioCue) -> AppResult<()> {
        let Some(wav) = self.configured(cue) else {
            // Node may not have completed bootstrap yet. No fallback tone is synthesized.
            return Ok(());
        };
        self.play_wav(&wav)
    }

    fn play_wav(&self, wav: &[u8]) -> AppResult<()> {
        validate_wav(wav)?;
        let wav = wav.to_vec();
        self.ui.run_on_main(move || {
            #[cfg(target_os = "macos")]
            return macos::play_wav(&wav);
            #[cfg(target_os = "windows")]
            return windows::play_wav(Arc::from(wav));
            #[allow(unreachable_code)]
            Err(AppError::Other("当前平台没有 Native 音效后端".into()))
        })?
    }

    fn configure_cues(
        &self,
        welcome: Option<Vec<u8>>,
        popup: Option<Vec<u8>>,
        retract: Option<Vec<u8>>,
    ) -> AppResult<()> {
        for wav in [&welcome, &popup, &retract].into_iter().flatten() {
            validate_wav(wav)?;
        }
        let mut clips = self.lock();
        clips.welcome = welcome.map(Arc::from);
        clips.popup = popup.map(Arc::from);
        clips.retract = retract.map(Arc::from);
        Ok(())
    }
}

#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "windows")]
pub mod windows;

#[cfg(test)]
mod tests {
    use super::*;

    /// 最小合法 WAV：44 字节头，`riff_len = 36`（= 44 - 8）。
    fn valid_wav() -> Vec<u8> {
        let mut wav = vec![0u8; 44];
        wav[..4].copy_from_slice(b"RIFF");
        wav[4..8].copy_from_slice(&36u32.to_le_bytes());
        wav[8..12].copy_from_slice(b"WAVE");
        wav
    }

    /// 可构造的端口实例：播放本身走平台 API（不可单测），这里只测「校验 / 选槽 /
    /// 未配置不合成兜底音」这些在触碰平台前的纯逻辑。句柄不会真的派发主线程任务。
    fn test_audio() -> Arc<NativeAudio> {
        native_audio(crate::ui::UiHandle::new(crate::ui::MainThreadQueue::new()))
    }

    #[test]
    fn wav校验拒绝非法头与长度不符() {
        assert!(validate_wav(&valid_wav()).is_ok());
        // 太短 / 头不符 / RIFF 声明长度与实体不符：都如实拒绝。
        assert!(validate_wav(&[]).is_err());
        assert!(validate_wav(&valid_wav()[..43]).is_err());
        let mut bad_magic = valid_wav();
        bad_magic[8..12].copy_from_slice(b"AVI ");
        assert!(validate_wav(&bad_magic).is_err());
        let mut bad_len = valid_wav();
        bad_len[4..8].copy_from_slice(&35u32.to_le_bytes());
        assert!(validate_wav(&bad_len).is_err());
        // 超过 4MB 上限：即使头部自洽也拒绝（有界数据是契约的一部分）。
        let mut huge = vec![0u8; 4 * 1024 * 1024 + 1];
        huge[..4].copy_from_slice(b"RIFF");
        huge[8..12].copy_from_slice(b"WAVE");
        let len = (huge.len() - 8) as u32;
        huge[4..8].copy_from_slice(&len.to_le_bytes());
        assert!(validate_wav(&huge).is_err());
    }

    #[test]
    fn 未配置音效时不播放也不合成兜底音() {
        let audio = test_audio();
        // Node 尚未 bootstrap（三槽全空）时，播放是静默成功：不合成兜底音、
        // 不派发任何平台调用。
        audio.play(AudioCue::Welcome).unwrap();
        audio.play(AudioCue::Popup).unwrap();
        audio.play(AudioCue::Retract).unwrap();
        assert!(audio.configured(AudioCue::Welcome).is_none());
    }

    #[test]
    fn 音效配置按cue分槽且校验失败不落半份() {
        let audio = test_audio();
        // 任一声部非法：整体拒绝，且不留下半份配置（三者校验都在写入之前）。
        let error = audio
            .configure_cues(Some(valid_wav()), Some(vec![1, 2, 3]), None)
            .unwrap_err();
        assert_eq!(error.code(), "CONFIG");
        assert!(
            audio.configured(AudioCue::Welcome).is_none(),
            "失败不得留下半份配置"
        );
        assert!(audio.configured(AudioCue::Popup).is_none());

        // 成功配置：每个 cue 只取到自己的槽。
        audio
            .configure_cues(Some(valid_wav()), None, Some(valid_wav()))
            .unwrap();
        assert!(audio.configured(AudioCue::Welcome).is_some());
        assert!(
            audio.configured(AudioCue::Popup).is_none(),
            "未配置的槽保持空"
        );
        assert!(audio.configured(AudioCue::Retract).is_some());

        // 重推全量（Node 重启后重新 bootstrap）覆盖旧值：清空即三槽全空。
        audio.configure_cues(None, None, None).unwrap();
        assert!(audio.configured(AudioCue::Welcome).is_none());
        assert!(audio.configured(AudioCue::Popup).is_none());
        assert!(audio.configured(AudioCue::Retract).is_none());
    }
}
