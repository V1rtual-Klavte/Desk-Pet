//! Windows WAV playback through independent winmm waveOut voices.
//!
//! Each cue gets an independent waveOut handle and retained WAVEHDR/data buffer, so overlapping
//! clips do not interrupt one another.

use crate::error::{AppError, AppResult};
use std::ffi::c_void;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;

type HWaveOut = isize;
const WAVE_MAPPER: u32 = u32::MAX;
const WAVE_FORMAT_PCM: u16 = 1;
const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
const MAX_VOICES: usize = 64;
const CALLBACK_FUNCTION: u32 = 0x0003_0000;
const WOM_DONE: u32 = 0x03BD;
const WAIT_OBJECT_0: u32 = 0;

#[repr(C)]
struct WaveFormatEx {
    format_tag: u16,
    channels: u16,
    samples_per_sec: u32,
    avg_bytes_per_sec: u32,
    block_align: u16,
    bits_per_sample: u16,
    extra_size: u16,
}

#[repr(C)]
struct WaveHeader {
    data: *mut i8,
    buffer_length: u32,
    bytes_recorded: u32,
    user: usize,
    flags: u32,
    loops: u32,
    next: *mut WaveHeader,
    reserved: usize,
}

// WinMM borrows this boxed header until the matching unprepare call completes.
unsafe impl Send for WaveHeader {}

struct WaveVoice {
    output: HWaveOut,
    header: Box<WaveHeader>,
    bytes: Box<[u8]>,
    header_size: u32,
    done_event: isize,
    timeout_ms: u32,
}

#[link(name = "winmm")]
unsafe extern "system" {
    fn waveOutOpen(
        output: *mut HWaveOut,
        device_id: u32,
        format: *const WaveFormatEx,
        callback: usize,
        instance: usize,
        flags: u32,
    ) -> u32;
    fn waveOutPrepareHeader(output: HWaveOut, header: *mut WaveHeader, size: u32) -> u32;
    fn waveOutWrite(output: HWaveOut, header: *mut WaveHeader, size: u32) -> u32;
    fn waveOutReset(output: HWaveOut) -> u32;
    fn waveOutUnprepareHeader(output: HWaveOut, header: *mut WaveHeader, size: u32) -> u32;
    fn waveOutClose(output: HWaveOut) -> u32;
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateEventW(
        attributes: *const c_void,
        manual_reset: i32,
        initial_state: i32,
        name: *const u16,
    ) -> isize;
    fn SetEvent(event: isize) -> i32;
    fn WaitForSingleObject(handle: isize, milliseconds: u32) -> u32;
    fn CloseHandle(handle: isize) -> i32;
}

unsafe extern "system" fn wave_out_callback(
    _output: HWaveOut,
    message: u32,
    instance: usize,
    _param1: usize,
    _param2: usize,
) {
    if message == WOM_DONE && instance != 0 {
        // SAFETY: waveOutOpen stores the live event handle as dwInstance for this voice.
        unsafe { SetEvent(instance as isize) };
    }
}

fn active_voices() -> &'static AtomicUsize {
    static ACTIVE: AtomicUsize = AtomicUsize::new(0);
    &ACTIVE
}

struct ParsedWave<'a> {
    format: WaveFormatEx,
    data: &'a [u8],
}

fn parse_wave(wav: &[u8]) -> AppResult<ParsedWave<'_>> {
    if wav.len() < 44 || &wav[..4] != b"RIFF" || &wav[8..12] != b"WAVE" {
        return Err(AppError::Config("Windows 音效不是有效 WAV 数据".into()));
    }
    let mut offset = 12usize;
    let mut format = None;
    let mut data = None;
    while offset.checked_add(8).is_some_and(|end| end <= wav.len()) {
        let id = &wav[offset..offset + 4];
        let size = u32::from_le_bytes(
            wav[offset + 4..offset + 8]
                .try_into()
                .expect("chunk header"),
        ) as usize;
        let start = offset + 8;
        let end = start
            .checked_add(size)
            .filter(|end| *end <= wav.len())
            .ok_or_else(|| AppError::Config("WAV chunk 长度越界".into()))?;
        if id == b"fmt " {
            if size < 16 {
                return Err(AppError::Config("WAV fmt chunk 太短".into()));
            }
            let chunk = &wav[start..end];
            format = Some(WaveFormatEx {
                format_tag: u16::from_le_bytes(chunk[0..2].try_into().expect("fmt")),
                channels: u16::from_le_bytes(chunk[2..4].try_into().expect("fmt")),
                samples_per_sec: u32::from_le_bytes(chunk[4..8].try_into().expect("fmt")),
                avg_bytes_per_sec: u32::from_le_bytes(chunk[8..12].try_into().expect("fmt")),
                block_align: u16::from_le_bytes(chunk[12..14].try_into().expect("fmt")),
                bits_per_sample: u16::from_le_bytes(chunk[14..16].try_into().expect("fmt")),
                extra_size: if size >= 18 {
                    u16::from_le_bytes(chunk[16..18].try_into().expect("fmt extension"))
                } else {
                    0
                },
            });
        } else if id == b"data" {
            data = Some(&wav[start..end]);
        }
        offset = end + (size & 1);
    }
    let format = format.ok_or_else(|| AppError::Config("WAV 缺少 fmt chunk".into()))?;
    let supported_depth = match format.format_tag {
        WAVE_FORMAT_PCM => matches!(format.bits_per_sample, 8 | 16 | 24 | 32),
        WAVE_FORMAT_IEEE_FLOAT => format.bits_per_sample == 32,
        _ => false,
    };
    let expected_align = format.channels.saturating_mul(format.bits_per_sample / 8);
    if !supported_depth
        || !(1..=8).contains(&format.channels)
        || !(8_000..=192_000).contains(&format.samples_per_sec)
        || format.block_align == 0
        || format.block_align != expected_align
        || u64::from(format.avg_bytes_per_sec)
            != u64::from(format.samples_per_sec) * u64::from(format.block_align)
    {
        return Err(AppError::Config("Windows WAV 格式不受 waveOut 支持".into()));
    }
    let data = data.ok_or_else(|| AppError::Config("WAV 缺少 data chunk".into()))?;
    if data.is_empty()
        || data.len() > u32::MAX as usize
        || data.len() % usize::from(format.block_align) != 0
    {
        return Err(AppError::Config("WAV 音频数据长度无效".into()));
    }
    Ok(ParsedWave { format, data })
}

pub fn play_wav(wav: &[u8]) -> AppResult<()> {
    let parsed = parse_wave(wav)?;
    let active = active_voices();
    active
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
            (count < MAX_VOICES).then_some(count + 1)
        })
        .map_err(|_| AppError::Other("Windows 并发音效 voice 已达上限".into()))?;

    // WOM_DONE signals this event from WinMM's callback; the callback itself does no cleanup.
    let done_event = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
    if done_event == 0 {
        active.fetch_sub(1, Ordering::AcqRel);
        return Err(AppError::Other("Windows 音效完成事件创建失败".into()));
    }

    // Start the reaper before submitting audio so thread creation failure cannot strand a
    // WinMM header/buffer after playback has begun.
    let (voice_tx, voice_rx) = std::sync::mpsc::sync_channel::<WaveVoice>(1);
    let reaper = thread::Builder::new()
        .name("deskpet-waveout-reaper".into())
        .spawn(move || {
            let Ok(mut voice) = voice_rx.recv() else {
                return;
            };
            let completed = unsafe { WaitForSingleObject(voice.done_event, voice.timeout_ms) };
            if completed != WAIT_OBJECT_0 {
                // A removed output device or driver fault can omit WOM_DONE. Stop this voice
                // before releasing its borrowed header and sample buffer.
                unsafe {
                    waveOutReset(voice.output);
                    WaitForSingleObject(voice.done_event, 1000);
                }
            }
            unsafe {
                waveOutUnprepareHeader(voice.output, voice.header.as_mut(), voice.header_size);
                waveOutClose(voice.output);
                CloseHandle(voice.done_event);
            }
            drop(voice.header);
            drop(voice.bytes);
            active.fetch_sub(1, Ordering::AcqRel);
        });
    if let Err(error) = reaper {
        unsafe { CloseHandle(done_event) };
        active.fetch_sub(1, Ordering::AcqRel);
        return Err(AppError::Other(format!(
            "Windows waveOut 回收线程创建失败：{error}"
        )));
    }

    let format = parsed.format;
    let mut bytes = parsed.data.to_vec().into_boxed_slice();
    let mut header = Box::new(WaveHeader {
        data: bytes.as_mut_ptr().cast(),
        buffer_length: bytes.len() as u32,
        bytes_recorded: 0,
        user: 0,
        flags: 0,
        loops: 0,
        next: std::ptr::null_mut(),
        reserved: 0,
    });
    let mut output: HWaveOut = 0;
    // SAFETY: format and waveOut structures follow the WinMM ABI; `bytes`/`header` remain
    // alive through the reaper thread until reset, unprepare, and close complete.
    let opened = unsafe {
        waveOutOpen(
            &mut output,
            WAVE_MAPPER,
            &format,
            wave_out_callback as usize,
            done_event as usize,
            CALLBACK_FUNCTION,
        )
    };
    if opened != 0 {
        unsafe { CloseHandle(done_event) };
        active.fetch_sub(1, Ordering::AcqRel);
        return Err(AppError::Other(format!(
            "Windows waveOutOpen 失败（MMRESULT={opened}）"
        )));
    }
    let header_ptr = header.as_mut() as *mut WaveHeader;
    let header_size = std::mem::size_of::<WaveHeader>() as u32;
    let prepared = unsafe { waveOutPrepareHeader(output, header_ptr, header_size) };
    if prepared != 0 {
        unsafe {
            waveOutClose(output);
            CloseHandle(done_event);
        }
        active.fetch_sub(1, Ordering::AcqRel);
        return Err(AppError::Other(format!(
            "Windows waveOutPrepareHeader 失败（MMRESULT={prepared}）"
        )));
    }
    let written = unsafe { waveOutWrite(output, header_ptr, header_size) };
    if written != 0 {
        unsafe {
            waveOutUnprepareHeader(output, header_ptr, header_size);
            waveOutClose(output);
            CloseHandle(done_event);
        }
        active.fetch_sub(1, Ordering::AcqRel);
        return Err(AppError::Other(format!(
            "Windows waveOutWrite 失败（MMRESULT={written}）"
        )));
    }

    let duration_ms = (u64::from(header.buffer_length) * 1000)
        .div_ceil(u64::from(format.avg_bytes_per_sec))
        .saturating_add(10_000)
        .min(u64::from(u32::MAX - 1)) as u32;
    let voice = WaveVoice {
        output,
        header,
        bytes,
        header_size,
        done_event,
        timeout_ms: duration_ms,
    };
    if let Err(error) = voice_tx.send(voice) {
        let mut voice = error.0;
        unsafe {
            waveOutReset(voice.output);
            waveOutUnprepareHeader(voice.output, voice.header.as_mut(), voice.header_size);
            waveOutClose(voice.output);
            CloseHandle(voice.done_event);
        }
        active.fetch_sub(1, Ordering::AcqRel);
        return Err(AppError::Other("Windows waveOut 回收线程提前退出".into()));
    }
    Ok(())
}
