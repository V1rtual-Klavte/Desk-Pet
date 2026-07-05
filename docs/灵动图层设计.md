# 灵动图层（Parallax Layers）— 景深视差系统

> 状态: 已完成 ✅
> 日期: 2026-07-02 (设计) → 2026-07-03 (完成 + Bug 修复)
> 关联: Profile v3、StreamView、useParallax

---

## 概述

为桌面宠物的"左边任务窗口"（StreamView 区域）引入五层视差图层系统。开启后，各图层根据自身深度跟随鼠标移动产生不同幅度的偏移，模拟 3D 景深效果。

### 核心效果

- **五层景深**：底背景 → 人物背景 → 角色本体 → 覆盖层1 → 覆盖层2
- **全局鼠标追踪**：Rust 后端 ~60fps 推送光标坐标，全屏幕追踪
- **弹簧物理跟随**：每层独立 Spring Animation，不同灵敏度产生惯性滞后感
- **3D 视觉增强**：CSS drop-shadow + brightness/contrast/saturate 按深度微调
- **始终 60fps**：不降频，保持最流畅体验

---

## 架构

```
┌─────────────────────────────────────────────────────┐
│ Rust 后端: cursor_tracker                           │
│  ├─ 独立线程，~16ms 间隔 poll                        │
│  │  └─ get_cursor_position() → 全局屏幕坐标          │
│  └─ emit("deskpet-cursor-move", {x, y, screen})     │
│     ★ 复用已有 commands/cursor.rs，需新增 emit       │
└────────────────────┬────────────────────────────────┘
                     │ Tauri Event (~60fps, 2 个数字)
     ┌───────────────▼───────────────────┐
     │ App.vue                            │
     │  ├─ listen("deskpet-cursor-move")  │
     │  │   → cursorRef = {x, y}          │
     │  └─ useParallaxEngine()            │
     │      composable (见下方)             │
     │      provide: parallaxState         │
     └───────────────┬───────────────────┘
                     │ props / provide
     ┌───────────────▼───────────────────┐
     │ StreamView.vue → ParallaxStack    │
     │  LayerEngine (composable)          │
     │  ├─ 5 层 DOM (v-if 按素材存在)     │
     │  ├─ Spring 物理逐帧更新             │
     │  ├─ CSS 3D 效果实时计算            │
     │  └─ 帧动画（仅 Layer 2 角色层）     │
     └───────────────────────────────────┘
```

---

## 五层定义

| 层 | 名称 | 素材 | 默认灵敏度 | 默认 Scale | 说明 |
|----|------|------|----------|-----------|------|
| L0 | 场景底背景 | `bg_base.png` | 0.2 | 1.02 | 最远，偏移最少，shadow 最重 |
| L1 | 人物背景 | `char_bg.png` | 0.5 | 1.01 | 光环/特效底座 |
| L2 | 角色本体 | 帧序列 PNG | 0.8 | 1.00 | **核心层**，保留帧动画逻辑 |
| L3 | 覆盖层1 | `overlay_1.png` | 1.2 | 0.99 | 前景光效/粒子 |
| L4 | 覆盖层2 | `overlay_2.png` | 1.6 | 0.98 | 最近，偏移最多，UI装饰框 |

**每层素材可选**：profile 中缺图的层跳过渲染，旧 profile 完全兼容（仅 L2 角色层始终存在）。

---

## 数据流

```
1. Rust cursor_tracker 每 16ms emit "deskpet-cursor-move" { x, y, screen_w, screen_h }

2. App.vue listener 存入 cursorRef（框架层 ref）

3. StreamView 挂载时创建 ParallaxEngine:
   ├─ 读取 profile 的 parallax 配置（或默认值）
   ├─ 检查 userConfig.parallaxEnabled
   └─ 若 disabled → 全部层静止在中央，无 3D 效果

4. RAF 循环 (始终 60fps):
   ├─ 读取 cursorRef → 计算相对窗口中心的归一化偏移 (-1 ~ +1)
   ├─ 对每层: spring.update(target) → 当前位移
   ├─ 对每层: 更新 CSS transform: translate(x, y) scale(s)
   └─ 循环

5. 素材加载: Profile loader 新增 getParallaxUrl(layer) → 存在返回URL，不存在返回 null
```

### Spring 物理

```
每帧更新:
  force  = stiffness * (target - position) - damping * velocity
  velocity += force * dt         (dt ≈ 16.67ms)
  position += velocity * dt

参数映射 (从 sensitivity s):
  stiffness = lerp(0.08, 0.20, s)   // s 越高越跟手
  damping   = lerp(0.75, 0.85, s)  // s 越高阻尼越低
  maxTravel = s * 30px              // 最大偏移量
```

### 3D 视觉效果（纯 CSS）

```
每层根据 depth（= sensitivity）计算:

  drop-shadow:  0 (depth*12)px (depth*8)px rgba(0,0,0, 0.15 + depth*0.08)
  brightness:   lerp(1.00, 0.92, depth)    // 远的层稍暗
  contrast:     lerp(1.05, 0.95, depth)    // 近的层对比略高
  saturate:     lerp(1.10, 0.90, depth)    // 近的层色彩更鲜艳
  scale:        lerp(1.02, 0.98, depth)    // 透视缩放
```

---

## 配置设计

### Profile `profile.yaml` 新增

```yaml
parallax:
  # enabled: 默认值，用户可在设置页覆盖
  enabled: true
  # 强度倍率，1.0 = 默认
  intensity: 1.0
  # 每层覆盖（可选，不配则用默认灵敏度）
  layers:
    layer_0:
      enabled: true
      sensitivity: 0.2
      shadow: 0.25      # 0~1
      brightness: 0.93
      contrast: 0.96
      saturate: 0.92
    # layer_1 ~ layer_4 同理...
```

### `userConfig`（localStorage）新增

```ts
parallaxEnabled: boolean   // 全局开关，优先级高于 profile 默认
parallaxIntensity: number  // 0~2 强度滑块，默认 1.0
```

### `CONFIG.yaml` — 无需改动（全局开关属用户偏好）

### 设置页

- 在 `SettingsPanel.vue` 新增"灵动图层"区块
- 一个开关（parallaxEnabled）
- 一个滑块（parallaxIntensity, 0~2, 步长 0.1）

---

## 文件变更清单

| 文件 | 变更 | 说明 |
|------|------|------|
| `src-tauri/src/commands/cursor.rs` | 修改 | 新增 cursor_tracker 线程 + emit event |
| `src-tauri/src/lib.rs` | 修改 | 注册 cursor_tracker 启动 |
| `src/services/profile/loader.ts` | 修改 | ProfileData 新增 parallax 类型；新增 getParallaxUrl() |
| `src/services/profile/index.ts` | 修改 | 导出 parallax 相关 |
| `src/components/StreamView.vue` | **重写** | 五层 DOM + LayerEngine composable |
| `src/composables/useParallax.ts` | **新建** | 核心：spring 物理 + 鼠标追踪 + 3D 效果计算 |
| `src/App.vue` | 修改 | listen cursor-move event + provide parallax state |
| `src/components/SettingsPanel.vue` | 修改 | 新增灵动图层开关+滑块 |
| `src/services/config.ts` | 修改 | userConfig 新增 parallax 字段 |
| `public/profiles/*/profile.yaml` | 修改 | 3 个内置 profile 新增 parallax 默认配置 |

---

## 性能考量

- **Rust 轮询**：独立线程 `std::thread::sleep(Duration::from_millis(16))`，开销可忽略
- **Tauri Event**：每帧仅 `{x: f64, y: f64, screen_w: u32, screen_h: u32}`，JSON 序列化 ~50 bytes
- **前端 RAF**：5 层 transform 更新，全部 GPU 合成，不触发 layout/paint
- **Spring 计算**：5 × 4 次浮点运算，每帧 < 1μs
- **不在后台消耗**：窗口不可见时 RAF 自然暂停（浏览器行为）

---

## 验收标准

- [x] 开启灵动图层后，鼠标移动时 5 层产生视差偏移
- [x] 各层灵敏度不同，明显可见景深层次
- [x] 关闭开关后所有层回到静止位置
- [x] 强度滑块实时调整偏移幅度
- [x] 旧 profile（无 parallax 配置）正常显示，仅 L2 角色层
- [x] 始终 60fps，无明显掉帧
- [x] macOS + Windows 双端一致

---

## Bug 记录 — 2026-07-03 三重连环 Bug

### 🐛 #1 死 Computed — `computed(() => getActiveProfile())`

**现象**: 灵动窗口五层全部不渲染，`layerUrls` 始终返回 `[null, null, null, null, null]`

**根因**: `getActiveProfile()` 读取模块级普通变量 `activeId` + `profiles` Map，不是 Vue 响应式数据。Vue 的 `computed()` 只能追踪 Proxy 包装的响应式数据，无法追踪模块变量变化 → 第一次求值返回 `null` 后**永远不会再求值**。

```ts
// ❌ 死 computed — 永远返回首次求值的缓存结果
const profile = computed(() => getActiveProfile());

// ✅ 修复: 直接在依赖 computed 内部调用，让其他响应式依赖触发重求值
const layerUrls = computed(() => {
  const p = getActiveProfile();  // 直接调用，随其他 deps 变化而重求值
  ...
});
```

**文件**: `src/components/StreamView.vue`

### 🐛 #2 数组索引赋值不触发 Vue computed 重求值

**现象**: `reloadParallax()` 成功设置 `parallaxConfig.value.layers[i] = merged`，日志显示图层数据正确，但 `layerUrls` computed 不重新求值

**根因**: `ref<T>()` 包装的对象内部，对数组的索引赋值 `arr[i] = x` 在 `setTimeout`/`setInterval` 回调中不触发 Vue 3 Proxy 的依赖追踪（可能与微任务调度时序有关）

```ts
// ❌ 索引赋值 — 不触发 computed 重求值
for (let i = 0; i < 5; i++) {
  parallaxConfig.value.layers[i] = merged;
}

// ✅ 修复: 构建新数组后整体替换引用，强制触发 Proxy set trap
const newLayers = [];
for (let i = 0; i < 5; i++) {
  newLayers.push(merged);
}
parallaxConfig.value.layers = newLayers;  // 属性替换 → 100% 触发响应式
```

**文件**: `src/components/StreamView.vue` → `reloadParallax()`

### 🐛 #3 冷启动时序竞态

**现象**: Profile 懒加载在 `App.vue.onMounted → initApp()` 中异步执行，但 `StreamView.onMounted` 早于父组件 onMounted 触发（Vue 子组件先挂载），导致首次 `reloadParallax()` 时 `getActiveProfile()` 返回 `null`，静默失败

```
Timeline:
  StreamView.onMounted → reloadParallax() → profile=null → 静默 return
  App.vue.onMounted → initApp() → initProfiles() → profile 加载完成 → 无人通知
```

**修复**:
1. `loader.ts` `activateProfile()`: 成功后 `localStorage.setItem("deskpet_parallax_dirty", "1")`
2. `StreamView.vue` `reloadParallax()`: profile=null 时 500ms 延迟重试（兜底）
3. `StreamView.vue` `onMounted`: 200ms 轮询检测 dirty flag → 触发图层重载

**文件**: `src/services/profile/loader.ts` + `src/components/StreamView.vue`

### 修复文件清单

| 文件 | 改动 |
|------|------|
| `src/services/profile/loader.ts` | `activateProfile()` 末尾加 dirty flag |
| `src/components/StreamView.vue` | 移除死 computed + 数组整体替换 + 500ms 重试 + 200ms 轮询 |
| `src/composables/useParallax.ts` | 无需修改（引擎逻辑正确） |
