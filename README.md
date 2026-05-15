# 抖音视频下载器

基于 Node.js + Playwright 的抖音视频下载工具，提供 Web UI 管理下载队列。

## 功能

- 粘贴抖音视频/合集链接，自动下载 MP4
- 合集批量提取（自动翻页扫描全部视频）
- 实时下载进度（速度、ETA、百分比）
- 并发控制（可调 1-10）
- 断点续传
- 自动重试 + CDN URL 过期刷新
- 支持自动保存或手动弹窗选择路径
- 无头浏览器模式

## 快速开始

### 前置要求

- [Node.js](https://nodejs.org/) >= 18
- Chromium（首次启动自动安装）

### 安装

```bash
npm install
```

### 获取 Cookie

工具需要抖音登录态才能调用 API。获取方式：

1. 浏览器登录抖音网页版 (https://www.douyin.com)
2. 打开开发者工具 (F12) → Application → Cookies → `douyin.com`
3. 找到 `sessionid` 和 `sessionid_ss`，导出为 JSON
4. 保存到 `~/.claude/douyin_cookies.json`

或者用 Chrome 插件 [EditThisCookie](https://chromewebstore.google.com/detail/editthiscookie/） 导出格式为：

```json
[
  { "name": "sessionid", "value": "xxx", "domain": ".douyin.com", "path": "/" },
  { "name": "sessionid_ss", "value": "xxx", "domain": ".douyin.com", "path": "/" }
]
```

### 启动

```bash
node server.js
```

打开 http://localhost:3000

### 构建 exe

```bash
node build.js
```

输出在 `dist/` 目录，双击 `启动.exe.bat` 运行。

## 配置

编辑 `config.js`：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| port | 3000 | 服务端口 |
| maxConcurrent | 3 | 最大并发下载数 |
| browserHeadless | true | 无头浏览器模式 |
| saveMode | auto | auto=自动保存到目录 / manual=弹窗选择 |

## 项目结构

```
├── server.js              # Express 服务入口
├── config.js              # 配置文件
├── build.js               # exe 构建脚本
├── src/
│   ├── browser.js         # Playwright 浏览器单例
│   ├── cookie-manager.js  # Cookie 加载/保存
│   ├── video-api.js       # 抖音 API 调用
│   ├── download-engine.js # HTTP 流式下载
│   ├── queue-manager.js   # 下载队列控制
│   ├── collection-extractor.js # 合集提取
│   ├── url-utils.js       # URL 解析
│   ├── filename-utils.js  # 文件名生成
│   └── sse.js             # SSE 实时推送
├── public/                # Web UI 静态文件
└── downloads/             # 默认下载目录
```

## 免责声明

本项目仅供学习和个人使用。下载的视频请尊重原作者版权，勿用于商业用途或传播。使用者需自行承担所有法律责任。
