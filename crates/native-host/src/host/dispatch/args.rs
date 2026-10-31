//! 分派器参数收窄：参数名逐字对齐 `src/services/host/types.ts` 的 camelCase 线格式。
//!
//! 缺必填/类型不符一律 CONFIG 错误；可选参数缺省与显式 null 等价（None）。

use std::collections::HashMap;

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use crate::error::{AppError, AppResult};

pub(super) fn ser<T: Serialize>(value: T) -> AppResult<Value> {
    serde_json::to_value(value).map_err(|error| AppError::Other(format!("结果序列化失败: {error}")))
}

pub(super) fn from_value<T: DeserializeOwned>(value: Value) -> AppResult<T> {
    serde_json::from_value(value)
        .map_err(|error| AppError::Config(format!("命令参数解析失败: {error}")))
}

pub(super) fn arg_value(args: &Value, key: &str) -> AppResult<Value> {
    args.get(key)
        .cloned()
        .filter(|value| !value.is_null())
        .ok_or_else(|| AppError::Config(format!("命令缺少参数: {key}")))
}

pub(super) fn decode_audio_clip(data: &str) -> AppResult<Vec<u8>> {
    use base64::Engine;
    const MAX_AUDIO_WAV_BYTES: usize = 8 * 1024 * 1024;
    if data.len() > MAX_AUDIO_WAV_BYTES * 4 / 3 + 4 {
        return Err(AppError::Tool("音效数据超过播放上限".into()));
    }
    base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|error| AppError::Tool(format!("音效编码无效: {error}")))
}

pub(super) fn arg_str(args: &Value, key: &str) -> AppResult<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| AppError::Config(format!("命令缺少字符串参数: {key}")))
}

pub(super) fn arg_opt_str(args: &Value, key: &str) -> AppResult<Option<String>> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(_) => Err(AppError::Config(format!("参数不是字符串或 null: {key}"))),
    }
}

pub(super) fn arg_bool(args: &Value, key: &str) -> AppResult<bool> {
    args.get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| AppError::Config(format!("命令缺少布尔参数: {key}")))
}

pub(super) fn arg_opt_bool(args: &Value, key: &str) -> AppResult<Option<bool>> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(flag)) => Ok(Some(*flag)),
        Some(_) => Err(AppError::Config(format!("参数不是布尔或 null: {key}"))),
    }
}

pub(super) fn arg_u64(args: &Value, key: &str) -> AppResult<u64> {
    args.get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| AppError::Config(format!("命令缺少非负整数参数: {key}")))
}

pub(super) fn arg_opt_u64(args: &Value, key: &str) -> AppResult<Option<u64>> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .map(Some)
            .ok_or_else(|| AppError::Config(format!("参数不是非负整数或 null: {key}"))),
    }
}

pub(super) fn arg_i64(args: &Value, key: &str) -> AppResult<i64> {
    args.get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| AppError::Config(format!("命令缺少整数参数: {key}")))
}

pub(super) fn arg_opt_i64(args: &Value, key: &str) -> AppResult<Option<i64>> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_i64()
            .map(Some)
            .ok_or_else(|| AppError::Config(format!("参数不是整数或 null: {key}"))),
    }
}

pub(super) fn arg_i32(args: &Value, key: &str) -> AppResult<i32> {
    let value = arg_i64(args, key)?;
    i32::try_from(value).map_err(|_| AppError::Config(format!("参数超出 i32 范围: {key}")))
}

pub(super) fn arg_opt_f64(args: &Value, key: &str) -> AppResult<Option<f64>> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_f64()
            .filter(|number| number.is_finite())
            .map(Some)
            .ok_or_else(|| AppError::Config(format!("参数不是有限数值或 null: {key}"))),
    }
}

pub(super) fn arg_usize(args: &Value, key: &str) -> AppResult<usize> {
    let value = arg_u64(args, key)?;
    usize::try_from(value).map_err(|_| AppError::Config(format!("参数超出 usize 范围: {key}")))
}

pub(super) fn arg_opt_usize(args: &Value, key: &str) -> AppResult<Option<usize>> {
    match arg_opt_u64(args, key)? {
        None => Ok(None),
        Some(value) => usize::try_from(value)
            .map(Some)
            .map_err(|_| AppError::Config(format!("参数超出 usize 范围: {key}"))),
    }
}

/// `level: number`（0=DEBUG..3=ERROR，Rust 侧为 u8）。
pub(super) fn arg_u8(args: &Value, key: &str) -> AppResult<u8> {
    let value = arg_u64(args, key)?;
    u8::try_from(value).map_err(|_| AppError::Config(format!("参数超出 u8 范围: {key}")))
}

/// 可选字符串数组：缺省 / null = None；给了就必须是字符串数组（逐项校验复用 `arg_strings`）。
pub(super) fn arg_opt_strings(args: &Value, key: &str) -> AppResult<Option<Vec<String>>> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(_)) => Ok(Some(arg_strings(args, key)?)),
        Some(_) => Err(AppError::Config(format!("参数不是字符串数组或 null: {key}"))),
    }
}

pub(super) fn arg_strings(args: &Value, key: &str) -> AppResult<Vec<String>> {
    let items = args
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::Config(format!("命令缺少字符串数组参数: {key}")))?;
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        out.push(
            item.as_str()
                .map(ToString::to_string)
                .ok_or_else(|| AppError::Config(format!("字符串数组含非字符串项: {key}")))?,
        );
    }
    Ok(out)
}

/// 字节参数（JSON number 数组；`$wireBlob` 上传标记已由桥在分派前物化为这个形态）。
pub(super) fn arg_bytes(args: &Value, key: &str) -> AppResult<Vec<u8>> {
    let items = args
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::Config(format!("命令缺少字节数组参数: {key}")))?;
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let byte = item
            .as_u64()
            .filter(|value| *value <= u64::from(u8::MAX))
            .ok_or_else(|| AppError::Config(format!("字节数组含非 0-255 项: {key}")))?;
        out.push(byte as u8);
    }
    Ok(out)
}

pub(super) fn arg_opt_string_map(
    args: &Value,
    key: &str,
) -> AppResult<Option<HashMap<String, String>>> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(map)) => {
            let mut out = HashMap::with_capacity(map.len());
            for (entry_key, entry_value) in map {
                let value = entry_value
                    .as_str()
                    .ok_or_else(|| AppError::Config(format!("{key} 含非字符串值: {entry_key}")))?;
                out.insert(entry_key.clone(), value.to_string());
            }
            Ok(Some(out))
        }
        Some(_) => Err(AppError::Config(format!("参数不是对象或 null: {key}"))),
    }
}
