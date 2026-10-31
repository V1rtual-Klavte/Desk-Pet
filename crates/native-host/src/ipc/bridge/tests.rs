use super::*;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::AsyncWrite;
use tokio::sync::{mpsc, watch};

use super::host::run_control_writer;
use crate::error::{AppError, AppResult};
use crate::ipc::blob::{self, WireBlobKind};
use crate::ipc::protocol::{HostBlobRef, RunScope, RuntimeMode, PROTOCOL_VERSION};
use crate::ipc::transport::{
    self, test_peer, ControlFrame, ControlPayload, CreditDirection, FramePayload,
};

struct VecWriter(Arc<StdMutex<Vec<u8>>>, Arc<tokio::sync::Notify>);

impl AsyncWrite for VecWriter {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .extend_from_slice(buf);
        self.1.notify_waiters();
        std::task::Poll::Ready(Ok(buf.len()))
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::task::Poll::Ready(Ok(()))
    }

    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::task::Poll::Ready(Ok(()))
    }
}

#[tokio::test]
async fn 控制帧优先于积压的普通帧() {
    let (control_tx, control_rx) = mpsc::channel(4);
    let (normal_tx, normal_rx) = mpsc::channel(8);
    for _ in 0..8 {
        normal_tx
            .send(NormalFrame::Bytes(vec![b'N']))
            .await
            .unwrap();
    }
    control_tx.send(vec![b'C']).await.unwrap();

    let captured = Arc::new(StdMutex::new(Vec::new()));
    let notify = Arc::new(tokio::sync::Notify::new());
    let (_closed_tx, closed_rx) = watch::channel(false);
    let writer = VecWriter(captured.clone(), notify.clone());
    tokio::spawn(run_control_writer(writer, control_rx, normal_rx, closed_rx));

    // 等 9 个字节全部写出。
    loop {
        if captured.lock().unwrap_or_else(|e| e.into_inner()).len() >= 9 {
            break;
        }
        let waiter = notify.notified();
        tokio::time::timeout(Duration::from_secs(2), waiter)
            .await
            .ok();
        if captured.lock().unwrap_or_else(|e| e.into_inner()).len() >= 9 {
            break;
        }
    }
    let out = captured.lock().unwrap_or_else(|e| e.into_inner()).clone();
    assert_eq!(out.len(), 9);
    assert_eq!(out[0], b'C', "控制帧必须先写出（biased 优先队列）");
    assert!(out[1..].iter().all(|b| *b == b'N'));
}

/// 端到端：真实端点 + 假 Node 客户端 + 真桥。
struct Harness {
    endpoint: Arc<transport::Endpoint>,
    bridge: HostBridge,
    expect: HelloExpectations,
    control: PeerStream,
    binary: PeerStream,
}

async fn setup(
    app_epoch: &str,
    node_epoch: u64,
    dispatcher: Arc<dyn CommandDispatcher>,
) -> Harness {
    let endpoint = Arc::new(transport::Endpoint::create().unwrap());
    let address = endpoint.address().to_string();
    let expect = HelloExpectations {
        app_version: "0.16.0".into(),
        expected_node_version: "22.22.3".into(),
        handshake_token: "tok".into(),
        runtime_mode: RuntimeMode::Development,
    };

    // 客户端控制连接 + hello
    let mut control_client = test_peer::connect_control(&address).await.unwrap();
    let hello = ClientHello {
        protocol_version: PROTOCOL_VERSION,
        handshake: "tok".into(),
        node_version: "22.22.3".into(),
    };
    transport::write_control_frame(
        &mut control_client,
        &ControlFrame::control(ControlPayload::Hello { hello }),
        64 * 1024,
    )
    .await
    .unwrap();

    let mut control_server = endpoint.accept_control().await.unwrap();
    let _hello = accept_control_handshake(
        &mut control_server,
        &expect,
        BridgeConfig::default().limits(),
        app_epoch,
        node_epoch,
    )
    .await
    .unwrap();

    // 二进制连接
    let acceptor = endpoint.clone();
    let token = "tok".to_string();
    let accept_task = tokio::spawn(async move { acceptor.accept_binary(&token).await });
    let (binary_client, status) = test_peer::connect_binary(&address, "tok").await.unwrap();
    assert_eq!(status, transport::HANDSHAKE_OK);
    let binary_server = accept_task.await.unwrap().unwrap();

    let bridge = HostBridge::start(
        control_server,
        binary_server,
        BridgeConfig::default(),
        app_epoch.to_string(),
        node_epoch,
        Arc::new(BlobRegistry::new()),
    );
    bridge.set_dispatcher(dispatcher);

    // 客户端读 welcome（握手完成的凭据）
    let welcome = transport::read_control_frame(&mut control_client, 64 * 1024)
        .await
        .unwrap();
    match welcome.payload {
        FramePayload::Control(ControlPayload::Welcome { welcome }) => {
            assert_eq!(welcome.app_epoch, app_epoch);
            assert_eq!(welcome.node_epoch, node_epoch);
        }
        other => panic!("期望 welcome，得到 {other:?}"),
    }

    Harness {
        endpoint,
        bridge,
        expect,
        control: control_client,
        binary: binary_client,
    }
}

async fn request(
    control: &mut PeerStream,
    request_id: u64,
    scope: Option<RunScope>,
    method: &str,
    args: Value,
) {
    transport::write_control_frame(
        control,
        &ControlFrame::request(request_id, scope, method, args),
        64 * 1024,
    )
    .await
    .unwrap();
}

async fn read_response(control: &mut PeerStream) -> super::super::transport::ResponsePayload {
    loop {
        let frame = transport::read_control_frame(control, 64 * 1024)
            .await
            .unwrap();
        if let FramePayload::Response(response) = frame.payload {
            return response;
        }
    }
}

struct EchoDispatcher;

impl CommandDispatcher for EchoDispatcher {
    fn dispatch(&self, _ctx: &DispatchContext, args: Value) -> AppResult<Value> {
        Ok(args)
    }
}

#[tokio::test]
async fn 关停先封宿主新工作但保留写盘与回执直到flush报告() {
    tokio::time::timeout(Duration::from_secs(3), async {
        let mut h = setup("shutdown-drain", 0, Arc::new(EchoDispatcher)).await;
        for request_id in 0..3 {
            h.bridge
                .publish_event(
                    "deskpet-host-request",
                    json!({"requestId": request_id, "method": "settings_commit"}),
                    h.bridge.default_scope(),
                )
                .unwrap();
        }
        h.bridge
            .request_shutdown("测试退出", Duration::from_secs(2))
            .await
            .unwrap();
        for request_id in 0..3 {
            let queued = transport::read_control_frame(&mut h.control, 64 * 1024)
                .await
                .unwrap();
            let FramePayload::Event(event) = queued.payload else {
                panic!("Shutdown 不得越过已经准入的宿主请求");
            };
            assert_eq!(event.event, "deskpet-host-request");
            assert_eq!(event.payload["requestId"], request_id);
        }
        let frame = transport::read_control_frame(&mut h.control, 64 * 1024)
            .await
            .unwrap();
        assert!(matches!(
            frame.payload,
            FramePayload::Control(ControlPayload::Shutdown { .. })
        ));
        assert!(!h.bridge.admission_open());
        assert!(h
            .bridge
            .publish_event("deskpet-host-request", json!({}), h.bridge.default_scope())
            .is_err());
        assert!(h
            .bridge
            .call("settings_read", json!({}), None, None)
            .await
            .is_err());

        // 大 CONFIG / 会话正文收尾仍可上传并走原来的分派与 scope 校验。
        transport::write_control_frame(
            &mut h.control,
            &ControlFrame::control(ControlPayload::BlobOpen {
                blob_id: "flush-config".into(),
                bytes: 5,
                kind: super::super::transport::BlobKind::Text,
            }),
            64 * 1024,
        )
        .await
        .unwrap();
        let ready = transport::read_control_frame(&mut h.control, 64 * 1024)
            .await
            .unwrap();
        assert!(matches!(
            ready.payload,
            FramePayload::Control(ControlPayload::BlobReady { .. })
        ));
        transport::write_binary_chunk(&mut h.binary, 0, true, b"saved", 64 * 1024)
            .await
            .unwrap();
        request(
            &mut h.control,
            1,
            None,
            "write_runtime_config",
            json!({"content": blob::upload_marker("flush-config", WireBlobKind::Text)}),
        )
        .await;
        let response = read_response(&mut h.control).await;
        assert!(response.ok, "{response:?}");
        assert_eq!(response.result.unwrap()["content"], "saved");
        request(
            &mut h.control,
            2,
            None,
            "host_request_result",
            json!({"ok": true}),
        )
        .await;
        assert!(read_response(&mut h.control).await.ok);

        transport::write_control_frame(
            &mut h.control,
            &ControlFrame::control(ControlPayload::ShutdownFlush {
                flushed: true,
                pending: 0,
                detail: Some("设置与回执已完成".into()),
            }),
            64 * 1024,
        )
        .await
        .unwrap();
        let flushed = h
            .bridge
            .wait_flush_report(Duration::from_secs(1))
            .await
            .unwrap();
        assert!(flushed.flushed);
        assert_eq!(flushed.pending, 0);
        request(&mut h.control, 3, None, "write_runtime_config", json!({})).await;
        let response = read_response(&mut h.control).await;
        assert!(!response.ok);
        assert_eq!(response.error.unwrap().code, "SHUTTING_DOWN");
        h.bridge.close_local("测试结束");
    })
    .await
    .expect("关停排空协议不得死锁");
}

struct BigTextDispatcher;

impl CommandDispatcher for BigTextDispatcher {
    fn dispatch(&self, _ctx: &DispatchContext, _args: Value) -> AppResult<Value> {
        Ok(json!({ "content": "长".repeat(200 * 1024 / 3 + 10) }))
    }
}

struct SlowDispatcher;

impl CommandDispatcher for SlowDispatcher {
    fn dispatch(&self, ctx: &DispatchContext, _args: Value) -> AppResult<Value> {
        for _ in 0..200 {
            if ctx.is_cancelled() {
                return Err(AppError::Cancelled);
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        Ok(json!({"done": true}))
    }
}

#[tokio::test]
async fn 请求响应往返与未接线命令如实报错() {
    let mut h = setup("boot-1", 0, Arc::new(UnavailableDispatcher)).await;
    request(&mut h.control, 1, None, "get_runtime_paths", json!({})).await;
    let response = read_response(&mut h.control).await;
    assert!(!response.ok);
    assert_eq!(
        response.error.as_ref().unwrap().code,
        "HOST_DISPATCH_UNAVAILABLE"
    );

    // 旧代际请求被拒（错误码稳定，供 Node 侧丢弃/重试判断）
    let stale = RunScope {
        app_epoch: "boot-1".into(),
        node_epoch: 99,
        ..Default::default()
    };
    request(
        &mut h.control,
        2,
        Some(stale),
        "get_runtime_paths",
        json!({}),
    )
    .await;
    let response = read_response(&mut h.control).await;
    assert_eq!(response.error.as_ref().unwrap().code, "SCOPE_STALE");

    // 接线后的回显
    h.bridge.set_dispatcher(Arc::new(EchoDispatcher));
    request(&mut h.control, 3, None, "echo", json!({"a": 1})).await;
    let response = read_response(&mut h.control).await;
    assert!(response.ok);
    assert_eq!(response.result.unwrap(), json!({"a": 1}));
    let _ = h.expect;
    let _ = (&h.endpoint, &h.binary);
}

#[tokio::test]
async fn 超长结果自动编码为blob并经二进制通道读回() {
    let mut h = setup("boot-1", 0, Arc::new(BigTextDispatcher)).await;
    request(&mut h.control, 1, None, "read_runtime_config", json!({})).await;
    let response = read_response(&mut h.control).await;
    assert!(response.ok, "{response:?}");
    let result = response.result.unwrap();
    let blob_ref: HostBlobRef = blob::parse_host_blob_marker(&result).expect("整包 JSON blob 标记");
    assert_eq!(result[blob::BLOB_ENCODING_KEY], "json");
    assert!(blob_ref.bytes > 64 * 1024, "超长字符串必须被编码为 blob");

    // Node 侧物化：blob_read → ok(bytes) → 二进制块（account credit 归还）
    request(
        &mut h.control,
        2,
        None,
        "blob_read",
        json!({"blobId": blob_ref.id}),
    )
    .await;
    let response = read_response(&mut h.control).await;
    assert!(response.ok, "{response:?}");
    assert_eq!(response.result.unwrap()["bytes"], blob_ref.bytes);

    let mut collected: Vec<u8> = Vec::new();
    loop {
        let chunk = transport::read_binary_chunk(&mut h.binary, 64 * 1024)
            .await
            .unwrap();
        assert_eq!(chunk.offset, collected.len() as u64, "offset 连续");
        collected.extend_from_slice(&chunk.data);
        // 归还信用（等价于 Node 侧消费后 grant）
        h.credit_grant(chunk.data.len() as u64).await;
        if chunk.last {
            break;
        }
    }
    assert_eq!(collected.len() as u64, blob_ref.bytes);
    let decoded: Value = serde_json::from_slice(&collected).unwrap();
    assert_eq!(
        decoded,
        json!({ "content": "长".repeat(200 * 1024 / 3 + 10) })
    );

    // release 后句柄不可再读
    request(
        &mut h.control,
        3,
        None,
        "blob_release",
        json!({"blobId": blob_ref.id}),
    )
    .await;
    let _ = read_response(&mut h.control).await;
    request(
        &mut h.control,
        4,
        None,
        "blob_read",
        json!({"blobId": blob_ref.id}),
    )
    .await;
    let response = read_response(&mut h.control).await;
    assert!(!response.ok, "已归还的句柄不得再读");
}

#[tokio::test]
async fn 聚合超限结果整包JSON_blob保留ASCII中文转义与数组() {
    let h = setup("boot-1", 0, Arc::new(UnavailableDispatcher)).await;
    let inner = &h.bridge.inner;
    let scope = RunScope {
        app_epoch: "boot-1".into(),
        node_epoch: 0,
        ..Default::default()
    };
    let original = json!({
        "ascii": "ordinary text",
        "cjk": "记忆检索结果",
        "escaped": "quote: \\\" slash: \\\\ newline: \\n",
        "matches": (0..5000).map(|n| json!({"id": n, "text": "小段"})).collect::<Vec<_>>(),
    });
    assert!(
        serde_json::to_vec(&ControlFrame::ok(77, original.clone()))
            .unwrap()
            .len()
            > inner.config.control_frame_max_bytes
    );
    let encoded = inner
        .encode_result_for_wire(77, &scope, original.clone())
        .unwrap();
    let blob_ref = blob::parse_host_blob_marker(&encoded).expect("整包结果应转为 blob");
    assert_eq!(encoded[blob::BLOB_ENCODING_KEY], "json");
    let bytes = inner.blobs.open_read(&blob_ref.id, &scope).unwrap();
    assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), original);
    assert!(transport::encode_control_frame(
        &ControlFrame::ok(77, encoded),
        inner.config.control_frame_max_bytes,
    )
    .is_ok());
}

#[tokio::test]
async fn 内联递归签发中途失败会归还本次已签发句柄() {
    let h = setup("boot-1", 0, Arc::new(UnavailableDispatcher)).await;
    let inner = &h.bridge.inner;
    let scope = RunScope {
        app_epoch: "boot-1".into(),
        node_epoch: 0,
        ..Default::default()
    };
    let calls = std::cell::Cell::new(0);
    let result = inner.encode_inline_fields_transactional(
        &scope,
        json!(["首个长字段".repeat(4000), "第二个长字段".repeat(4000)]),
        |blob_scope, text| {
            let next = calls.get() + 1;
            calls.set(next);
            if next == 2 {
                return Err(AppError::Other("注入的第二次签发失败".into()));
            }
            inner
                .blobs
                .issue_host_blob(blob_scope.clone(), text.into_bytes(), None)
        },
    );
    assert!(result.is_err());
    assert_eq!(calls.get(), 2, "失败应发生在首个句柄已签发之后");
    assert_eq!(inner.blobs.len(), 0, "失败事务必须归还之前签发的句柄");
}

#[tokio::test]
async fn JSON上传递归物化嵌套标记且保留scope和一次性消费() {
    let h = setup("boot-1", 0, Arc::new(UnavailableDispatcher)).await;
    let inner = &h.bridge.inner;
    let scope = RunScope {
        app_epoch: "boot-1".into(),
        node_epoch: 0,
        ..Default::default()
    };
    inner
        .blobs
        .register_upload(
            "nested-text",
            scope.clone(),
            b"inside".to_vec(),
            WireBlobKind::Text,
        )
        .unwrap();
    let nested = blob::upload_marker("nested-text", WireBlobKind::Text);
    inner
        .blobs
        .register_upload(
            "outer-json",
            scope.clone(),
            serde_json::to_vec(&json!({"nested": nested})).unwrap(),
            WireBlobKind::Json,
        )
        .unwrap();
    let result = inner
        .materialize_args(
            &scope,
            blob::upload_marker("outer-json", WireBlobKind::Json),
        )
        .unwrap();
    assert_eq!(result, json!({"nested": "inside"}));

    inner
        .blobs
        .register_upload(
            "invalid-json",
            scope.clone(),
            b"{".to_vec(),
            WireBlobKind::Json,
        )
        .unwrap();
    assert!(inner
        .materialize_args(
            &scope,
            blob::upload_marker("invalid-json", WireBlobKind::Json),
        )
        .is_err());
    assert!(
        inner
            .materialize_args(
                &scope,
                blob::upload_marker("invalid-json", WireBlobKind::Json),
            )
            .is_err(),
        "无效 JSON 上传也必须一次性消费"
    );

    inner
        .blobs
        .register_upload(
            "wrong-scope",
            scope.clone(),
            b"[]".to_vec(),
            WireBlobKind::Json,
        )
        .unwrap();
    let other_scope = RunScope {
        node_epoch: 1,
        ..scope.clone()
    };
    assert!(inner
        .materialize_args(
            &other_scope,
            blob::upload_marker("wrong-scope", WireBlobKind::Json),
        )
        .is_err());
    assert!(
        inner
            .materialize_args(
                &scope,
                blob::upload_marker("wrong-scope", WireBlobKind::Json),
            )
            .is_err(),
        "scope 拒绝后上传句柄不得复活"
    );
}

impl Harness {
    async fn credit_grant(&mut self, bytes: u64) {
        transport::write_control_frame(
            &mut self.control,
            &ControlFrame::control(ControlPayload::Credit {
                direction: CreditDirection::HostToNode,
                bytes,
            }),
            64 * 1024,
        )
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn 上传标记在分派前被物化为完整原值() {
    let mut h = setup("boot-1", 0, Arc::new(EchoDispatcher)).await;
    // 公告 → 等 ready → 发块 → 请求引用
    transport::write_control_frame(
        &mut h.control,
        &ControlFrame::control(ControlPayload::BlobOpen {
            blob_id: "up-1".into(),
            bytes: 5,
            kind: super::super::transport::BlobKind::Text,
        }),
        64 * 1024,
    )
    .await
    .unwrap();
    // 等 BlobReady（控制帧可能与其他帧交错）
    loop {
        let frame = transport::read_control_frame(&mut h.control, 64 * 1024)
            .await
            .unwrap();
        if let FramePayload::Control(ControlPayload::BlobReady { .. }) = frame.payload {
            break;
        }
    }
    transport::write_binary_chunk(&mut h.binary, 0, true, b"hello", 64 * 1024)
        .await
        .unwrap();
    // 归还信用帧会回来（NodeToHost），读走它们
    let marker = blob::upload_marker("up-1", WireBlobKind::Text);
    request(
        &mut h.control,
        1,
        None,
        "file_write",
        json!({"content": marker}),
    )
    .await;
    let response = read_response(&mut h.control).await;
    assert!(response.ok, "{response:?}");
    assert_eq!(
        response.result.unwrap()["content"],
        "hello",
        "上传必须物化回原字符串"
    );
}

#[tokio::test]
async fn 取消先于迟到结果且不等在数据后面() {
    let mut h = setup("boot-1", 0, Arc::new(SlowDispatcher)).await;
    request(&mut h.control, 1, None, "bash_exec", json!({})).await;
    // 稍等分派开始后取消
    tokio::time::sleep(Duration::from_millis(30)).await;
    transport::write_control_frame(
        &mut h.control,
        &ControlFrame::control(ControlPayload::Cancel { request_id: 1 }),
        64 * 1024,
    )
    .await
    .unwrap();
    let response = tokio::time::timeout(Duration::from_secs(1), read_response(&mut h.control))
        .await
        .expect("取消响应不得等待分派跑完");
    assert_eq!(response.error.as_ref().unwrap().code, "CANCELLED");
}

#[tokio::test]
async fn 事件帧进广播且旧代际被丢弃() {
    let mut h = setup("boot-1", 0, Arc::new(EchoDispatcher)).await;
    // 订阅方 = 路由任务的同一入口（事件路由从这条广播消费）。
    let mut events = h.bridge.subscribe_events();

    // 当前代际事件：送达广播（名字、序号与载荷原样）。
    let scope = h.bridge.default_scope();
    transport::write_control_frame(
        &mut h.control,
        &ControlFrame::event(
            scope,
            "tool-executing",
            7,
            json!({"toolId": "t1", "toolName": "bash"}),
        ),
        64 * 1024,
    )
    .await
    .unwrap();
    let envelope = tokio::time::timeout(Duration::from_secs(2), events.recv())
        .await
        .expect("期限内应收到事件")
        .expect("广播未关闭");
    assert_eq!(envelope.event, "tool-executing");
    assert_eq!(envelope.seq, 7);
    assert_eq!(
        envelope.payload,
        json!({"toolId": "t1", "toolName": "bash"})
    );

    // 旧代际事件：在 `dispatch_event` 按 scope 丢弃（契约 §4.1，旧 Node 的事件
    // 不得写新状态），不进入广播。
    let stale = RunScope {
        app_epoch: "boot-1".into(),
        node_epoch: 99,
        ..Default::default()
    };
    transport::write_control_frame(
        &mut h.control,
        &ControlFrame::event(stale, "tool-executing", 8, json!({})),
        64 * 1024,
    )
    .await
    .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(200), events.recv())
            .await
            .is_err(),
        "旧代际事件不得进广播"
    );
}
