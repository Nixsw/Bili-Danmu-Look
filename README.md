# DanmuTools

DanmuTools 是一个 Windows 10+ x64 桌面弹幕消息展示小工具。它使用 Tauri v2 + React，窗口为半透明置顶挂件，右侧显示主消息流，左侧显示按 UID 锚定的指定人最近发言。

## 当前进度

更新时间：2026-06-25

### 已完成

- Tauri v2 + React 桌面应用骨架，目标 Windows 10+ x64。
- 半透明、无边框、置顶主窗口，支持拖动、缩放、托盘菜单和配置持久化。
- 启动窗口默认隐藏，前端首帧渲染后再显示，避免启动时短暂白框闪烁。
- HTTP/HTTPS 连接接口取参、Bilibili WebSocket 二进制协议、入房、心跳、断线重连和开发用 mock WebSocket 服务端。
- 联调探测会采集 `DANMU_MSG` 和 `SUPER_CHAT_MESSAGE` raw JSON，并写出字段路径报告。
- 普通弹幕和 SC 醒目留言都进入主列表、UID 锚定和已读逻辑。
- 连接接口失败后本地每 2 秒重试，HTTP 请求超时为 20 秒；WS 失败会清理旧连接缓存并重新请求接口。
- 顶部状态点后显示短状态文本，例如“对接中...”“接口.请求超时, X秒后重试”“连接.意外断开, X秒后重试”“已连接！”。
- 设置弹层使用“保存接口”保存 HTTP/HTTPS 接口 URL，浏览器预览继续走 mock WebSocket。
- 主消息区按时间正序显示，新消息追加但不强制自动追最新。
- 主消息区支持鼠标滚轮查看历史和新消息；普通浏览保持列表边界，已读推进和定位未读会将目标贴顶，后续不足一屏时底部留空。
- 主消息区下方有隐藏更新时显示紧凑的“还有 N 条更新”提示。
- 顶部“定位未读消息”按钮会将全局最早未读置顶；没有未读时跳到最新一屏。
- 右侧只能点击全局最早未读来标记已读，随后下一条全局最早未读滚动到首行；跳过点击只查看左侧人物消息。
- 已读推进为 140 毫秒位移过渡，定位为 180 毫秒；动画可被新操作打断，只保留有限可见内容，结束后释放。
- 指定人区域常驻，点击主消息后按 UID（用户标识）展示该用户发言，并把被点击消息设为锚点。
- 设置弹层提供“左侧历史条数”滑条，范围 0-3，控制指定人锚点上方尽量保留的历史发言数量。
- 指定人锚点保持可见；有新消息时锚点最高停在第二行；溢出时显示“还有 N 条更新”。
- 指定人区域支持滚轮查看该用户历史和更新，鼠标悬停时冻结自动视口移动。
- 主消息和指定人消息的右键菜单支持复制、全部已读此人，不提供收起指定人区域的入口。
- Bilibili 直播风格荣耀等级、粉丝等级、大航海图标和舰长/提督/总督昵称固定色。
- 主消息和指定人消息默认使用透明列表风格，去掉单条消息玻璃卡背景。
- 主消息 hover 只让昵称、内容、等级和粉丝等级轻微变亮。
- 指定人已读状态改为内容变淡；时间单独使用更灰、更浅的颜色，hover 时不过度点燃。
- 托盘菜单保留“显示/隐藏”“设置”“退出”，移除“断开”“重连”入口。

### 最近修复

- 修复主消息区手动滚动后，新消息进入时视口可能异常留白的问题。
- 修复窗口拉伸高度时，列表底部短暂空一块的问题。
- 修复指定人区域消息多时锚点乱跳、锚点被缓存裁剪后消失的问题。
- 修复左侧指定人区域已读后时间颜色被整行透明度一起压灰的问题。
- 修复启动时 WebView 初始白底先闪一下再显示正常 UI 的问题。
- 修复连接接口返回错误后不会持续重试的问题。
- 修复连接状态临时提示文案过长、格式不统一的问题。
- 修复展开/收起指定人区域时透明置顶窗口闪出下层窗口内容的问题。
- 修复展开/收起指定人区域时窗口位置累计向左偏移的问题；现在窗口几何使用外框尺寸，内容布局使用内容区尺寸，右边缘锚定不再累计漂移。
- 修复展开/收起按钮图标方向和最小化按钮语义。
- 主消息区底部提供紧凑更新提示，顶部按钮用于定位未读锚点。
- 修复指定人锚点上方历史条数固定的问题；现在可在设置中按 0-3 调整。

### 最近验证

- `npm test`：77 个测试通过。
- `npm run build`：通过。
- `cargo test --manifest-path src-tauri\Cargo.toml`：43 个测试通过，1 个真实联调测试默认忽略。
- `npm run tauri:build`：Windows x64 release、NSIS、MSI 构建通过。
- `npm run package:portable`：便携 zip 生成通过。
- 桌面启动验证：release exe 可从隐藏启动进入可见主窗口，进程响应正常。

## 运行要求

- Node.js 20+ 和 npm
- Rust/Cargo
- Windows WebView2 Runtime
- Visual Studio Build Tools C++ 工具链

当前项目目录已包含前端、Tauri 配置、Rust 源码、Bilibili 协议解析、单元测试和开发用 mock WebSocket 服务端。

## 常用命令

```powershell
npm install
npm test
npm run build
npm run mock:ws
npm run tauri:dev
npm run tauri:build
npm run package:portable
```

mock 服务端默认监听：

```text
ws://127.0.0.1:17878
```

真实连接配置使用 HTTP/HTTPS 接口：

```text
connectApiUrl=http://127.0.0.1:2333/api/v1/external/danmu-reader/connect?token=...
```

接口返回的 `token`、`uid`/`mid`、`room_id`、`wsurl` 只在 Rust 后端用于入房和订阅；当前联调确认 `wsurl` 可为数组，`mid` 会作为入房 `uid` 使用。本地连接失败后每 2 秒重试获取连接信息，HTTP 请求超时为 20 秒；WS 连接失败会清理旧连接信息，下一轮重新请求接口。

联调探测仍保留为后端调试命令，可通过 ignored 测试采样 raw payload。报告默认写入：

```text
%APPDATA%\DanmuTools\DanmuTools\config\bilibili-probe-report.json
```

也可以用 ignored 测试跑单次真实 probe：

```powershell
$env:DANMUTOOLS_CONNECT_API_URL="http://127.0.0.1:2333/api/v1/external/danmu-reader/connect?token=..."
cargo test --manifest-path src-tauri\Cargo.toml live_probe_from_env_writes_report -- --ignored --nocapture
```

打包后主要产物位于：

- `src-tauri/target/release/danmu-tools.exe`
- `src-tauri/target/release/bundle/nsis/DanmuTools_1.3.0_x64-setup.exe`
- `src-tauri/target/release/bundle/msi/DanmuTools_1.3.0_x64_zh-CN.msi`
- `src-tauri/target/release/bundle/portable/DanmuTools_1.3.0_x64_portable.zip`

## 消息 JSON 格式

浏览器预览仍接收 JSON mock；真实 Bilibili 二进制协议只走 Tauri/Rust 后端。进入前端 store 的标准字段：

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

`timestampMs` 为 Unix 毫秒时间戳；如果只有 `timestamp`，会按 Unix 秒时间戳处理。
当前解析校验：`userLevel` 为 0-100，`fanLevel` 为 0-120，`guardType` 为 0-3。
SC 醒目留言使用 `messageType: "superChat"`，并可带 `superChat.price`、`superChat.durationSec`、`superChat.startTimeMs`、`superChat.endTimeMs`。

## 核心交互

- 主消息区从第一行开始累计，窗口未满时底部留空。
- 新消息追加到底部，但主消息区不会强制自动滚到最新。
- 主消息区和指定人区域都支持鼠标滚轮向上查看历史、向下查看更新。
- 普通滚轮浏览保持首条可贴顶、末条可贴底；已读推进和定位未读必须让目标出现在第一行，允许末尾留空。
- 点击主消息会更新左侧指定人记录；仅当点击的是全局最早未读时才标记已读，随后平滑推进到下一条全局最早未读。
- 左侧可自由逐条标记已读，右键菜单仍可全部已读此人；若读掉全局最早未读，也会触发主列表推进。
- 指定人区域按 UID 显示，点击的主消息作为锚点，锚点必须保持可见。
- 指定人区域鼠标悬停时冻结自动上移；新消息仍进入缓存，离开后按锚点规则补齐。

## 后续待定

- 继续用联调报告校准稀有字段；没有捕获到 SC 样本时，不硬编码未确认路径。
- 继续根据实际 Bilibili 下发字段校准粉丝牌颜色、图标资源和昵称颜色。
- 可选功能暂未做：搜索、过滤、完整主题系统、点击穿透、开机自启。
