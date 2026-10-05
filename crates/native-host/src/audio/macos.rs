//! macOS WAV 播放：AppKit `NSSound` 直接读取内存数据，不写临时文件。

use crate::error::{AppError, AppResult};
use objc2::rc::Retained;
use objc2::{AnyThread, MainThreadMarker};
use objc2_app_kit::NSSound;
use objc2_foundation::NSData;
use std::cell::RefCell;

thread_local! {
    /// NSSound 是 AppKit 对象，仅在主线程保留仍在播放的每个 voice；并发 cue 不互相截断。
    static SOUNDS: RefCell<Vec<Retained<NSSound>>> = const { RefCell::new(Vec::new()) };
}

fn make_sound(wav: &[u8]) -> AppResult<Retained<NSSound>> {
    // SAFETY: wav is bounded and validated RIFF/WAVE data; NSData copies this live slice.
    let data = unsafe { NSData::dataWithBytes_length(wav.as_ptr().cast(), wav.len()) };
    NSSound::initWithData(NSSound::alloc(), &data)
        .ok_or_else(|| AppError::Other("无法创建 macOS WAV 播放对象".into()))
}

pub fn play_wav(wav: &[u8]) -> AppResult<()> {
    let _mtm = MainThreadMarker::new()
        .ok_or_else(|| AppError::Other("macOS WAV 只能在 AppKit 主线程播放".into()))?;
    const MAX_VOICES: usize = 64;
    let at_capacity = SOUNDS.with(|sounds| {
        let mut sounds = sounds.borrow_mut();
        sounds.retain(|voice| voice.isPlaying());
        sounds.len() >= MAX_VOICES
    });
    if at_capacity {
        return Err(AppError::Other("macOS 并发音效 voice 已达上限".into()));
    }
    let sound = make_sound(wav)?;
    if !sound.play() {
        return Err(AppError::Other("macOS NSSound 未能开始播放 WAV".into()));
    }
    // A separate NSSound instance gives each overlapping WAV its own playback position.
    SOUNDS.with(|sounds| sounds.borrow_mut().push(sound));
    Ok(())
}
