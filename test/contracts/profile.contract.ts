// Profile 域契约 —— 加载/自包含与显式管理操作。
//
// 范围：`test/unit/profile/加载与自包含.test.ts` 与 `test/unit/profile/导入与ID推导.test.ts`
// 的全部 caseId 锚点。Profile 是舞台素材与主题层配置的目录级自包含单元：设置页列 Profile、
// 编辑器读写、创建/导入/重命名/删除都以 `data_root/profiles/<id>` 为唯一真相源。
// `src/services/profile/loader.ts` 同时列在 native-ui 契约（nui-37 的保存后缓存收敛），
// 两边依赖的行为面不同、各自按声明集合算 hash（env/host 共享 node-ports.ts 的先例）。
//
// 原生窗口的预览绘制与 promote 属原生 UI 自动化缺口（见《未完成工作与已知缺口》§9），
// 不在本契约冒充；本契约全部覆盖点在 L2，门槛按既有 no-e2e 契约的先例归零清空 ——
// 跨层完整性由 checkLayerCoverage 负责。
import type { ModuleContract } from "../host/types"

export const profileContract: ModuleContract = {
  module: "profile",
  sourceFiles: [
    "src/services/profile/index.ts",
    "src/services/profile/loader.ts",
    "src/services/profile/io.ts",
  ],
  sourceHash: "875f35e333532d787c912209394274b81c26b44831c0dadb5ee6534e9239ce84",
  coverage: [
    {
      id: "pr-01",
      feature: "Profile 的轻量 meta 读取、自包含加载与激活切换",
      description:
        "readProfileMeta 每次都从磁盘读 meta（缺省时 name=id、空描述、version 1，读取失败返回 null），既不被加载器缓存代答、也不回写缓存 —— 加载器先装入旧内容后，磁盘改新再读 meta 得到新值而加载器缓存仍是旧值。ensureProfileLoaded 只从 Profile 自身目录构建：没有层配置时就是空层、不借邻居的层；profile.yaml 缺失返回 null，不伪造空 Profile。parallax 逐层套默认值：索引 1 默认关闭、索引 2 默认启用并带 L2 素材，默认表只有 5 层，超出索引回退最后一层且不产出 undefined。switchActiveProfile 只接受可加载的 Profile，失败保持原激活项",
      why: "设置页列出的名字/版本若来自缓存就会与磁盘分叉；跨 Profile 回退会让一个坏 Profile 静默显示邻居素材；伪造空 Profile 会把「文件缺失」伪装成合法空壳；失败仍切换会把舞台指向不存在的目录",
      layer: "unit",
      depth: "deep",
      scenarios: [
        "profile-meta-fresh-read",
        "profile-meta-defaults-and-missing",
        "profile-self-contained-layers",
        "profile-missing-yaml-null",
        "profile-parallax-layer-defaults",
        "profile-switch-active-guard",
      ],
    },
    {
      id: "pr-02",
      feature: "Profile 管理往返：导入、新建、重命名与 ID / 展示路径",
      description:
        "importProfileZip 只依赖 `{ name, arrayBuffer }` 结构且只取一次字节，按文件名推导 ID 后真实落盘；缺 profile.yaml 或无法推导合法 ID 时拒绝且一个文件都不落，同路径条目按大小写口径如实报告覆盖并跳过 macOS 隐藏文件，写盘失败返回失败结果而不是抛出、不留下成功假象。createProfile 预置五层空壳 profile.yaml 与 materials/L0..L4 目录，ID 取最小未占用序号（磁盘实际文件为准），默认名被占用时按（2）后缀避让，新建后目录可直接写图读回。renameProfile 只改 meta.name（两侧空白裁掉、id 目录与文件名不动），纯空白与其它 Profile 重名都被拒绝且磁盘一个字节不动。nextCreateId 取最小未占用新建名、不跳号；profileDisplayPath 固定为数据根下 profiles/<id>。断言一律回读磁盘文件，不相信返回值",
      why: "返回值与磁盘分叉会让设置页显示不存在或半份的 Profile；导入半途落盘或写失败仍报成功会把损坏目录留在数据根；ID 跳号/重排会改变按 id 保存的引用（appearance.activeProfile），而重命名搬迁目录会让正在使用的 Profile 路径失效",
      layer: "unit",
      depth: "deep",
      scenarios: [
        "profile-import-roundtrip",
        "profile-import-reject-missing-yaml",
        "profile-import-reject-invalid-id",
        "profile-import-collision-report",
        "profile-import-write-failure",
        "profile-create-scaffold",
        "profile-create-writable-layers",
        "profile-create-id-sequence",
        "profile-rename-display-name",
        "profile-rename-reject-blank",
        "profile-rename-reject-duplicate",
        "profile-create-default-name-avoid",
        "profile-next-create-id",
        "profile-display-path",
      ],
    },
  ],
  rules: { minScenarios: 0, minDeepScenarios: 0, requireBoundary: false, requireErrorPath: false },
}

export default profileContract
