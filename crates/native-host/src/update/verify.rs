// ==========================================
// release envelope 验签与制品哈希（W10b）
// ==========================================
//
// 两个信任动作分开、都可注入：
// - [`EnvelopeVerifier`]：校验 feed 里 envelope 原始字节的分离签名。生产实现是
//   minisign/ed25519（沿用既有发布公钥，见 packaging/update.json）；
//   测试注入假实现，把「坏签名拒绝」分支与真实密钥隔离。
// - [`Sha256Hex`]：制品下载/复核时的流式 SHA-256。
//
// 制品签名/哈希**另验证**（契约 §4.5）：envelope 验签只证明"清单没被换"，
// 下载字节仍要逐字节对 envelope 里的 size/sha256 复核（见 stage.rs）。

use sha2::{Digest, Sha256};

use crate::error::AppResult;

use super::manifest::{update_error, E_BAD_SIGNATURE};

/// 分离签名校验口。失败必须如实返回错误（不允许返回 bool 让调用方"顺手放过"）。
pub trait EnvelopeVerifier: Send + Sync {
    /// `envelope` 是 feed 里 `envelope` 字段的**原始字节**；`signature` 是 minisign 签名块。
    fn verify(&self, envelope: &[u8], signature: &str) -> AppResult<()>;
}

/// 生产验签器：minisign 公钥钉死在编译期（`packaging/update.json`），
/// 不读环境、不读磁盘、不做"找不到公钥就跳过校验"的降级。
pub struct MinisignVerifier {
    key: minisign_verify::PublicKey,
}

impl MinisignVerifier {
    pub fn new(public_key_base64: &str) -> AppResult<Self> {
        // 公钥原文是 key 文件的第二行（base64 of 42-byte key）；容忍首尾空白，
        // 不接受 "untrusted comment:" 头 —— 那说明配置里放的是 key 文件全文，
        // 与本函数约定不符，直接报错而不是替调用方猜。
        let key =
            minisign_verify::PublicKey::from_base64(public_key_base64.trim()).map_err(|e| {
                update_error(
                    super::manifest::E_BAD_KEY,
                    format!("release 公钥不可用: {e}"),
                )
            })?;
        Ok(Self { key })
    }
}

impl EnvelopeVerifier for MinisignVerifier {
    fn verify(&self, envelope: &[u8], signature: &str) -> AppResult<()> {
        let signature = minisign_verify::Signature::decode(signature)
            .map_err(|e| update_error(E_BAD_SIGNATURE, format!("签名块不可解析: {e}")))?;
        // allow_legacy = true：同时接受现代 prehashed（BLAKE2b）与旧版 minisign 的
        // 整包签名形态。信任锚是钉死的公钥与 ed25519 本身，这里只选择消息预处理，
        // 不放宽任何密钥/身份判定。
        self.key
            .verify(envelope, &signature, true)
            .map_err(|e| update_error(E_BAD_SIGNATURE, format!("release envelope 验签失败: {e}")))
    }
}

/// 流式 SHA-256（下载边读边算，不把整包读进内存）。
pub struct Sha256Hex {
    hasher: Sha256,
}

impl Sha256Hex {
    pub fn new() -> Self {
        Self {
            hasher: Sha256::new(),
        }
    }

    pub fn update(&mut self, bytes: &[u8]) {
        self.hasher.update(bytes);
    }

    /// 结束并输出小写十六进制摘要。消费 self，防止复用同一实例算第二次。
    pub fn finish(self) -> String {
        hex_encode(&self.hasher.finalize())
    }
}

impl Default for Sha256Hex {
    fn default() -> Self {
        Self::new()
    }
}

/// 一次性字节的 SHA-256（小对象：feed、签名测试向量等）。
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex_encode(&hasher.finalize())
}

pub fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::update::manifest::E_BAD_SIGNATURE;

    // 真实 minisign 测试向量（取自 minisign-verify 0.2.5 的官方用例）：
    // 公钥、签名与签名对象 `b"test"` 三件齐备，用来验**生产验签器**本身，
    // 而不是只验我们自己的包装逻辑。
    const VECTOR_PUBKEY: &str = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    const VECTOR_SIGNATURE: &str = "untrusted comment: signature from minisign secret key
RWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=
trusted comment: timestamp:1555779966\tfile:test
QtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==";

    #[test]
    fn 真实验签器接受合法签名并拒绝篡改() {
        let verifier = MinisignVerifier::new(VECTOR_PUBKEY).unwrap();
        verifier
            .verify(b"test", VECTOR_SIGNATURE)
            .expect("合法签名必须通过");
        // 被签字节改一个字符就必须拒绝（坏签名分支）
        let err = verifier.verify(b"Test", VECTOR_SIGNATURE).unwrap_err();
        assert_eq!(err.code(), E_BAD_SIGNATURE);
    }

    #[test]
    fn 坏公钥与坏签名块都拒绝() {
        assert!(MinisignVerifier::new("not-base64!!!").is_err());
        let verifier = MinisignVerifier::new(VECTOR_PUBKEY).unwrap();
        let err = verifier.verify(b"test", "不是签名块").unwrap_err();
        assert_eq!(err.code(), E_BAD_SIGNATURE);
    }

    #[test]
    fn 另一把公钥的签名不被接受() {
        // 只有信任锚匹配才通过：换成别的（结构合法）公钥后同一签名必须失败。
        // 用的是本应用真值那把公钥（packaging/update.json 的同值）：与本用例无关的
        // 「另一把」身份只要求结构合法；不要用历史里那份 pk 体抄错一个字符的变体，
        // 免得再被谁抄走。
        let other =
            MinisignVerifier::new("RWQBS1lrNG3Ji1IlxfcL37gSCZAgz8ZqxCOIGuXMYKoCKFgNpaW2uAWE")
                .unwrap();
        assert!(other.verify(b"test", VECTOR_SIGNATURE).is_err());
    }

    #[test]
    fn sha256_与标准向量一致() {
        // 空串与 "abc" 的 SHA-256 标准向量（NIST）
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        // 流式与一次性结果一致
        let mut stream = Sha256Hex::new();
        stream.update(b"a");
        stream.update(b"bc");
        assert_eq!(stream.finish(), sha256_hex(b"abc"));
    }
}
