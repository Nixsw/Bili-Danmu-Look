# AGENTS.md

本文件给后续在本仓库工作的 Codex/开发代理使用。请优先遵守这里的项目约定，再结合用户最新要求行动。

## 项目概览

DanmuTools 是 Windows 10+ x64 桌面弹幕展示小工具，技术栈为 Tauri v2 + React + TypeScript + Rust。

核心形态：

- 半透明、无边框、置顶桌面窗口。
- 右侧为主消息流。
- 左侧为按 UID 锚定的指定人消息记录。
- Rust 侧负责 HTTP 连接接口、Bilibili WebSocket、缓存、视口推进、锚点规则、配置、托盘和打包。
- 前端负责渲染、测量可见行数、提交用户操作和视觉状态。

## 重要目录

- `src/`：React 前端。
- `src/core/`：前端 fallback 消息 store 与核心类型。
- `src/ui/`：格式化、布局、Bilibili 徽章样式和视口容量工具。
- `src-tauri/src/`：Tauri/Rust 后端、状态 store、Bilibili 协议、WebSocket、commands、托盘。
- `src-tauri/tauri.conf.json`：Tauri 窗口与打包配置。
- `src-tauri/capabilities/main.json`：Tauri 前端可调用权限。
- `scripts/mock-ws.ts`：开发用 mock WebSocket 服务端。
- `public/bili/`：Bilibili 风格徽章/大航海图标资源。

## 常用命令

```powershell
npm test
npm run build
cargo test --manifest-path src-tauri\Cargo.toml
npm run mock:ws
npm run tauri:dev
npm run tauri:build
npm run package:portable
```

mock WebSocket 默认地址：

```text
ws://127.0.0.1:17878
```

当前发布产物：

- `src-tauri/target/release/danmu-tools.exe`
- `src-tauri/target/release/bundle/nsis/DanmuTools_1.2.1_x64-setup.exe`
- `src-tauri/target/release/bundle/msi/DanmuTools_1.2.1_x64_zh-CN.msi`
- `src-tauri/target/release/bundle/portable/DanmuTools_1.2.1_x64_portable.zip`

## 开发约定

- 代码改动后优先跑最小相关测试；涉及共享逻辑、视口、锚点、缓存或打包时，跑完整 `npm test` 和 `cargo test --manifest-path src-tauri\Cargo.toml`。
- 前端视觉或交互改动后，至少跑 `npm run build`；如果影响桌面启动、权限、窗口行为或打包配置，必须跑 `npm run tauri:build`。
- 打包前如果 `src-tauri/target/release/danmu-tools.exe` 被占用，只关闭本项目路径下的 `danmu-tools.exe` 进程，不要误杀其他工作树或 mock 服务端。
- 不要自动停止用户正在测试的 mock WebSocket 服务端，除非用户明确要求。
- 不要随意改真实 JSON 字段路径；接入真实直播协议时，以 probe 报告和 raw payload 为准，尽量只改解析层。
- 不要把未请求的搜索、过滤、主题系统、点击穿透、开机自启等功能顺手加入。

## 关键行为约束

主消息区：

- 空窗口从第一行开始累计，窗口未满时底部留空。
- 普通滚轮浏览保持正常列表边界；已读推进或定位未读时，目标必须贴顶，后续不足一屏允许底部留空。
- 新消息追加到底部，但不要强制自动滚到最新。
- 鼠标滚轮支持向上看历史、向下看更新。
- 右侧单条点击只允许标记全局最早未读；跳过点击仍选择左侧人物锚点，但不记住或补标已读。
- 全局最早未读被读后，将下一条全局最早未读滚动到第一行；定位未读也从整个缓存查找并置顶。
- 已读推进动画为 140 毫秒，定位为 180 毫秒；只对有限可见内容做位移动画，连续操作可打断，不逐帧调用后端。
- 右键菜单支持复制弹幕、复制昵称、复制 UID、全部已读此人。

指定人区域：

- 左侧指定人区域常驻，不提供收起入口。
- 点击主消息后按 UID 展示该用户发言，并把被点击消息设为锚点。
- 锚点必须保持可见。
- 选择锚点时按设置保留上方历史；默认有更早历史时不要把锚点放到第一行。
- 没有更早历史时，锚点允许在第一行。
- 新消息不能自动移动左侧当前视口；未满时允许在下方追加，满后只更新“还有 N 条更新”。
- 鼠标悬停或移出指定人区域都不能补做自动滚动，数据仍进入缓存。
- 指定人消息也支持滚轮看历史和更新。
- 左侧逐条点击和右键批量已读不受右侧顺序限制；读掉全局最早未读时同样触发主列表推进。
- 右键菜单支持复制弹幕、全部已读。

缓存与锚点：

- 主消息缓存裁剪时，不能删除当前指定人锚点所需消息。
- 每 UID 缓存裁剪时，不能删除当前选中 UID 的锚点消息。
- 点击右侧仍在缓存中的旧消息时，必须补回可能已被个人索引裁掉的锚点，确保左侧标记可见。
- 全局缓存达到配置上限时，按上限的十分之一向上取整批量清理；保护锚点，优先保留左侧可见内容，其余按较早已读、较早未读的顺序清理。清理同时释放消息和索引，容量不变。
- 全局未读达到配置上限的 90% 时，右侧底部显示“还有 N 条更新 - 即将爆满”；已读或清理后重新判断。
- 如果改缓存逻辑，必须同时检查 Rust `src-tauri/src/store.rs` 和前端 fallback `src/core/messageStore.ts`。

窗口行为：

- 主窗口半透明、无边框、置顶、可拖动、可缩放。
- 主窗口禁止系统最大化；配置和备用创建路径都必须关闭最大化能力，同时保留手动缩放。
- `tauri.conf.json` 中主窗口当前为 `visible: false`，前端首帧渲染后调用 `getCurrentWindow().show()`，用于避免启动白框闪烁。
- 如果改窗口显示/隐藏，确认 `src-tauri/capabilities/main.json` 里有对应权限。
- 顶部拖动区域不要放置会吞掉拖动事件的大块交互层。

视觉约束：

- 主消息和指定人消息默认是透明列表，不要恢复单条玻璃卡背景。
- 主消息 hover 只让昵称、弹幕内容、荣耀等级、粉丝等级轻微变亮，不要整块高亮。
- 指定人已读状态只让内容和时间进入较浅灰色系，不要对整行做 `opacity` 或 `filter`，否则时间会被一起压灰。
- 已读指定人消息 hover 不要变成纯白强点燃。
- Bilibili 风格荣耀等级、粉丝等级、大航海图标、昵称颜色应尽量保持与既有实现一致。

## 当前标准消息 JSON

```json
{
  "content": "弹幕内容",
  "uid": "100000001",
  "nickname": "观众昵称",
  "userLevel": 12,
  "fanLevel": 8,
  "guardType": 0,
  "messageType": "danmu",
  "timestampMs": 1700000000000
}
```

说明：

- `content` 长度 1-40，汉字、英文、数字都按 1 个字符计。
- `uid` 是 8 字节整数，内部统一转成字符串展示和索引。
- `userLevel` 当前范围 0-100。
- `fanLevel` 当前按 Bilibili 官方上限支持 0-120。
- `guardType`：`0=无`，`1=总督`，`2=提督`，`3=舰长`。
- `messageType`：`danmu=普通弹幕`，`superChat=醒目留言`。
- `superChat` 可选字段保存 SC 价格、时长和开始/结束时间。
- `timestampMs` 为毫秒时间戳；如果只有 `timestamp`，按秒时间戳归一化。

## 验证清单

改动完成前按影响范围选择：

- 纯文档：读回文件并检查 diff。
- 前端逻辑：`npm test`。
- 前端渲染/类型：`npm run build`。
- Rust store/commands/config：`cargo test --manifest-path src-tauri\Cargo.toml`。
- Tauri 权限、窗口、启动、打包：`npm run tauri:build`。
- 便携包：`npm run package:portable`。
- 视觉修复：用浏览器或桌面实际渲染检查，不要只靠 CSS 推断。

## 协作注意

- 用户通常用中文沟通，回复也优先中文。
- 用户更看重实际可测结果和本机验证，不喜欢只给方案不落地。
- 如果用户说“先分析”“找到根因后停下”，不要直接实施。
- 如果用户说“实施”，默认直接改代码并验证。
- 工作区可能已有未提交变更，不要回滚非自己本轮相关的改动。
