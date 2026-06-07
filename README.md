# Claude Web — 随时随地通过网页访问本地 Claude Code

## 架构概览

```
┌──────────────────┐         ┌─────────────────────┐         ┌──────────────────┐
│  你的任意设备       │  HTTPS  │  阿里云服务器          │  WebSocket │  你的本地机器       │
│  手机/平板/笔记本   │ ◄─────► │  8.138.246.166       │ ◄────────► │  家里/公司电脑      │
│                   │         │                      │           │                  │
│  浏览器打开网页     │         │  server/ (Node.js)    │           │  agent/ (Node.js) │
│  输入 Token 即可    │         │  - 网页服务            │           │  - 连接云端        │
│  跟 Claude 对话    │         │  - WebSocket 中继     │           │  - 调用 claude CLI│
└──────────────────┘         └─────────────────────┘         └──────────────────┘
```

## 哪部分在哪里运行？

| 组件 | 运行位置 | 作用 |
|------|----------|------|
| `server/` | **☁️ 阿里云服务器** (8.138.246.166) | 提供网页界面 + WebSocket 中继转发 |
| `agent/` | **🖥️ 你的本地机器** | 连接云服务器，接收消息，调用本地 Claude Code |
| 浏览器 | **📱 任意设备** | 打开网页 `http://8.138.246.166:3000`，输入 Token，跟 Claude 对话 |

### 数据流

```
浏览器发消息 ──WS──► 云服务器(中继) ──WS──► 本地Agent ──spawn──► claude -p --output-format stream-json
                                                                          │
浏览器渲染 ◄──WS── 云服务器(转发) ◄──WS── 本地Agent ◄──stdout──┘
```

## 文件结构

```
claude-web/
├── config.json             # 配置文件（含 Token）
├── deploy.sh               # ☁️ 云服务器一键部署脚本
├── start-local.sh          # 🖥️ 本地 Agent 一键启动脚本
├── README.md               # 本文档
├── server/                 # ☁️ 云服务器端
│   ├── package.json
│   ├── index.js            # Express + WebSocket 中继服务器
│   ├── auth.js             # Token 认证（时间安全比较）
│   └── public/
│       ├── index.html      # 聊天界面（登录 + 对话）
│       ├── style.css       # 深色主题，移动端优先
│       └── app.js          # WebSocket 客户端 + 流式渲染
└── agent/                  # 🖥️ 本地 Agent
    ├── package.json
    └── index.js            # WS 客户端 + Claude Code 进程管理
```

---

## 🚀 部署步骤

### 第一步：部署云服务器 (server/)

在**本地机器**上运行以下命令，自动完成部署：

```bash
# 一键部署到阿里云服务器
bash /home/zss/workspace/claude-web/deploy.sh
```

这个脚本会自动：
1. 检查远程服务器环境（Node.js, PM2）
2. 如需要，安装 Node.js 24.x
3. 如需要，安装 PM2 进程管理器
4. 上传 `server/` 和 `config.json` 到服务器
5. 安装 npm 依赖
6. 启动服务（PM2 守护进程模式）
7. 开放防火墙端口 3000
8. 验证服务可访问

### 第二步：启动本地 Agent (agent/)

在**本地机器**上运行：

```bash
# 一键启动本地 Agent
bash /home/zss/workspace/claude-web/start-local.sh
```

Agent 会：
1. 连接到云服务器 `ws://8.138.246.166:3000`
2. 使用 Token 认证
3. 等待来自浏览器的消息
4. 收到消息后调用本地 `claude` CLI，流式返回结果

### 第三步：打开网页开始对话

1. 浏览器打开 `http://8.138.246.166:3000`
2. 输入 Token: `NNvEOIh2xapSnHr6Hi5mK0AN-PkCpr5t`
3. 看到 Agent 在线（绿色指示灯）后，开始对话

---

## 🔐 安全配置（重要）

### 修改默认 Token

编辑 `config.json`，将 token 改为你自己的强密码：

```bash
# 生成安全随机 Token
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

修改后需要**两边都重新启动**：
- 云服务器: `pm2 restart claude-web-server`
- 本地: `pm2 restart claude-web-agent` 或重启脚本

### 配置 HTTPS（推荐）

生产环境建议使用 Nginx + Let's Encrypt：

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

### 阿里云安全组

在阿里云控制台 → 安全组 → 入方向规则中开放：
- `3000` (TCP) — Claude Web 服务端口
- `443` (TCP) — HTTPS（配置 Nginx 后）
- `22` (TCP) — SSH

---

## 🔧 日常管理

### 查看状态

```bash
# 云服务器上
ssh root@8.138.246.166 "pm2 status"

# 本地机器上
pm2 status
```

### 查看日志

```bash
# 云服务器
ssh root@8.138.246.166 "pm2 logs claude-web-server --lines 20"

# 本地 Agent
pm2 logs claude-web-agent --lines 20
```

### 重启服务

```bash
# 云服务器
ssh root@8.138.246.166 "pm2 restart claude-web-server"

# 本地 Agent
pm2 restart claude-web-agent
```

### 停止服务

```bash
# 云服务器
ssh root@8.138.246.166 "pm2 stop claude-web-server"

# 本地 Agent
pm2 stop claude-web-agent
```

---

## ❓ 常见问题

**Q: 网页打开后显示 Agent 离线？**
A: 确保本地 Agent 已启动并连接到云服务器。检查本地网络是否正常。

**Q: 消息发送后没响应？**
A: 检查本地 Agent 日志 `pm2 logs claude-web-agent`，确认 Claude CLI 可用。

**Q: 如何更新 Token？**
A: 编辑 `config.json`，修改 token，然后两边都重启。

**Q: 移动端如何访问？**
A: 手机浏览器直接打开 `http://8.138.246.166:3000`，界面自动适配。

**Q: 如何让多个设备同时使用？**
A: 支持多个浏览器客户端同时连接，每个客户端独立会话（独立 session-id）。
