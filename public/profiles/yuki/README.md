# yuki 内置 Profile 素材契约

此目录会随 Tauri 打包，属于只读内置资源。用户点击“复制”后，副本应写入运行时数据目录的 `profiles/yuki`，不修改本目录。

需要将同一张原图抠成五张、画布尺寸完全一致且背景带 alpha 的 PNG：

- `materials/L0/bg_base.png`：最底层背景/远景
- `materials/L1/rain_mid.png`：中远景雨滴或玻璃高光
- `materials/L2/body.png`：角色主体
- `materials/L3/highlights.png`：前景细节/发丝/衣物高光
- `materials/L4/rain_front.png`：最前景雨滴/玻璃反光

五张图必须保持原图画布和主体位置一致，透明区域不能填充纯色背景。
