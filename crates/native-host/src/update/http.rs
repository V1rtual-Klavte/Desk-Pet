// ==========================================
// 更新取字节：HTTPS 端口（W10b）
// ==========================================
//
// 端口化：`UpdateRuntime` 只认识 [`HttpClient`]，生产实现是 ureq；测试注入内存读取器，
// 「不下载任何真实制品」的检查与单测都不碰网络。
//
// 纪律：
// - 只允许 https://（URL 与**重定向后的最终 URL** 都要是 https —— 重定向降级等于
//   明文投毒面）；
// - 响应体由调用方给上限（feed 与制品上限不同，见 manifest::FeedLimits）；
//   超限**报错**而不是截断 —— 截断的 JSON / 制品后续关卡的报错会掩盖真实原因。
// - 超时是硬性的（连接/读/写），更新流程不允许挂死宿主。

use std::io::Read;
use std::time::Duration;

use crate::error::AppResult;

use super::manifest::{update_error, E_INSECURE_URL, E_NETWORK, E_TOO_LARGE};

/// 一次 GET 的结果：调用方拿读取器自行消费（小 feed 读满上限；制品按块流入文件+哈希）。
pub trait HttpClient: Send + Sync {
    fn get(&self, url: &str) -> AppResult<Box<dyn Read + Send + Sync>>;
}

/// 生产实现（ureq：rustls + ring + webpki-roots）。
///
/// 阻塞式是刻意的：调用点在 IPC 的 `spawn_blocking` 分派线程与退出序列主线程，
/// 两处都不在 tokio 的 async 上下文；更新不是高频路径，不需要异步化。
pub struct UreqHttp {
    agent: ureq::Agent,
}

impl UreqHttp {
    pub fn new() -> Self {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(15))
            .timeout_read(Duration::from_secs(60))
            .timeout_write(Duration::from_secs(30))
            .redirects(5)
            .user_agent(concat!(
                "v1rtual-desk-pet-updater/",
                env!("CARGO_PKG_VERSION")
            ))
            .build();
        Self { agent }
    }
}

impl Default for UreqHttp {
    fn default() -> Self {
        Self::new()
    }
}

impl HttpClient for UreqHttp {
    fn get(&self, url: &str) -> AppResult<Box<dyn Read + Send + Sync>> {
        if !url.starts_with("https://") {
            return Err(update_error(
                E_INSECURE_URL,
                format!("更新只允许 https:// 地址: {url}"),
            ));
        }
        let response = self
            .agent
            .get(url)
            .call()
            .map_err(|e| update_error(E_NETWORK, format!("请求 {url} 失败: {e}")))?;
        let final_url = response.get_url().to_string();
        if !final_url.starts_with("https://") {
            return Err(update_error(
                E_INSECURE_URL,
                format!("重定向后的地址不是 https://: {final_url}"),
            ));
        }
        Ok(Box::new(response.into_reader()))
    }
}

/// 带上限读取：超限报 `E_TOO_LARGE`，不截断。
pub fn read_capped(reader: &mut dyn Read, cap: u64, what: &str) -> AppResult<Vec<u8>> {
    let mut out = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    loop {
        let read = reader
            .read(&mut chunk)
            .map_err(|e| update_error(E_NETWORK, format!("读取 {what} 失败: {e}")))?;
        if read == 0 {
            break;
        }
        if out.len() as u64 + read as u64 > cap {
            return Err(update_error(
                E_TOO_LARGE,
                format!("{what} 超过上限 {cap} 字节（拒绝截断）"),
            ));
        }
        out.extend_from_slice(&chunk[..read]);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn read_capped_超限报错不截断() {
        let mut small = Cursor::new(b"hello".to_vec());
        assert_eq!(read_capped(&mut small, 5, "test").unwrap(), b"hello");

        let mut over = Cursor::new(b"hello!".to_vec());
        let err = read_capped(&mut over, 5, "test").unwrap_err();
        assert_eq!(err.code(), E_TOO_LARGE);
    }

    // 假 HTTP 端口的形状（真实网络路径由 W10 的实机升级验收覆盖）：
    // 单测只证明依赖注入成立、上限生效，不模拟 TLS。
    struct FakeHttp(Vec<u8>);
    impl HttpClient for FakeHttp {
        fn get(&self, _url: &str) -> AppResult<Box<dyn Read + Send + Sync>> {
            Ok(Box::new(Cursor::new(self.0.clone())))
        }
    }

    #[test]
    fn 可注入端口返回字节流() {
        let http = FakeHttp(b"{\"ok\":true}".to_vec());
        let mut reader = http.get("https://example.com/update.json").unwrap();
        let bytes = read_capped(&mut reader, 1024, "feed").unwrap();
        assert_eq!(bytes, b"{\"ok\":true}");
    }
}
