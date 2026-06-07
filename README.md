# Claude Web — 随时随地通过网页访问本地 Claude Code

Claude Web 让你在任何设备（手机、平板、笔记本）的浏览器上与本地 Claude Code 对话。不需要在手机上安装任何 App，打开浏览器即可。

## 工作原理

```
┌──────────────────┐         ┌─────────────────────┐         ┌──────────────────┐
│  你的任意设备       │  HTTPS  │  云服务器 (你的)      │  WebSocket │  你的本地机器       │
│  手机/平板/笔记本   │ ◄─────► │  (需自行准备)         │ ◄────────► │  家里/公司电脑      │
│                   │         │                      │           │                  │
│  浏览器打开网页     │         │  server/ (Node.js)    │           │  agent/ (Node.js) │
│  输入 Token 即可    │         │  - 网页服务            │           │  - 连接云端        │
│  跟 Claude 对话    │         │  - WebSocket 中继     │           │  - 调用 claude CLI│
└──────────────────┘         └─────────────────────┘         └──────────────────┘
```

### 数据流

```
浏览器发消息 ──WS──► 云服务器(中继) ──WS──► 本地Agent ──spawn──► claude -p --output-format stream-json
                                                                          │
浏览器渲染 ◄──WS── 云服务器(转发) ◄──WS── 本地Agent ◄──stdout──┘
```

## 📋 你需要准备什么

在开始之前，请确保你具备以下条件：

| 准备项 | 说明 |
|--------|------|
| **云服务器** (必需) | 一台有公网 IP 的 Linux 服务器（阿里云、腾讯云、AWS 等均可）。推荐配置：1 核 2G 内存，系统 Ubuntu 20.04+ 或 CentOS 7+ |
| **域名** (推荐) | 用于 HTTPS 访问。非必需但强烈推荐，否则浏览器和 Agent 之间通过明文 WebSocket 通信 |
| **Claude Code** | 在你的本地机器上安装 [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) CLI |
| **Node.js** | 本地机器和云服务器上都需要 Node.js 18+ |
| **基本运维知识** | 能够 SSH 登录服务器、开放防火墙端口、使用 PM2 管理进程 |

### 关于云服务器

**你需要自行准备一台云服务器。** 这是必需的，因为：

1. **公网可达** — 你的手机/平板需要通过公网 IP 访问到它
2. **WebSocket 中继** — 它负责在浏览器和你的本地 Agent 之间转发消息
3. **静态文件服务** — 托管聊天界面网页

推荐的最便宜方案：
- **阿里云 ECS**：最低配约 ¥50/月
- **腾讯云轻量应用服务器**：最低配约 ¥40/月
- **AWS EC2 t3.micro**：免费套餐（首年）
- **Vultr / DigitalOcean**：$6/月

> 💡 选择离你最近的区域以获得更低延迟。服务器操作系统推荐 Ubuntu 22.04。

## 🚀 部署步骤

### 第一步：配置

```bash
# 1. 克隆项目
git clone https://github.com/BUG423/Web-Claude.git
cd Web-Claude

# 2. 创建配置文件
cp config.json.example config.json

# 3. 编辑 config.json
# - serverHost: 填入你的云服务器公网 IP
# - token: 用以下命令生成安全随机 Token
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

### 第二步：部署云服务器 (server/)

**在你的本地机器上**运行以下命令，自动完成远程部署：

```bash
bash deploy.sh
```

脚本会自动：
1. 检查远程服务器环境（Node.js, PM2）
2. 如需要，安装 Node.js 24.x
3. 如需要，安装 PM2 进程管理器
4. 上传 `server/` 和 `config.json` 到服务器
5. 安装 npm 依赖
6. 启动服务（PM2 守护进程模式）
7. 开放防火墙端口
8. 验证服务可访问

> 部署过程中会提示你输入服务器的 SSH 密码。

**手动部署替代方案**（如果自动脚本不适用）：

```bash
# 1. 上传文件到服务器
scp -r server/ config.json root@你的服务器IP:/root/claude-web/

# 2. SSH 登录服务器
ssh root@你的服务器IP

# 3. 在服务器上
cd /root/claude-web/server
npm install --production
pm2 start index.js --name claude-web-server
pm2 save
```

### 第三步：启动本地 Agent (agent/)

在**运行 Claude Code 的本地机器**上：

```bash
bash start-local.sh
```

Agent 会：
1. 连接到你的云服务器 `ws://你的服务器IP:3000`
2. 使用 Token 认证
3. 等待来自浏览器的消息
4. 收到消息后调用本地 `claude` CLI，流式返回结果

### 第四步：开始对话

1. 浏览器打开 `http://你的服务器IP:3000`
2. 输入你在 config.json 中设置的 Token
3. 看到 Agent 在线（绿色指示灯）后，即可开始对话

## 🔐 安全配置

### 修改默认 Token

编辑 `config.json`，将 token 改为你自己的强密码：

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

修改后需要**两边都重新启动**：
- 云服务器: `pm2 restart claude-web-server`
- 本地 Agent: 重启 `start-local.sh` 或 `pm2 restart claude-web-agent`

### 配置 HTTPS（强烈推荐）

生产环境必须使用 Nginx + Let's Encrypt 配置 HTTPS：

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

配置 HTTPS 后，修改 `config.json` 中的 `useTLS` 为 `true`。

### 防火墙 / 安全组

在云服务器控制台的安全组中开放以下端口：
- `3000` (TCP) — Claude Web 服务端口
- `443` (TCP) — HTTPS（配置 Nginx 后）
- `22` (TCP) — SSH

> ⚠️ **安全提醒**：不要将 config.json 上传到公开仓库。.gitignore 已默认排除它。Token 相当于你的密码，泄露意味着任何人都能以你的身份使用 Claude Code。

## 📁 文件结构

```
claude-web/
├── config.json             # 配置文件（含 Token，不提交到 git）
├── config.json.example     # 配置文件模板
├── deploy.sh               # 云服务器一键部署脚本
├── start-local.sh          # 本地 Agent 一键启动脚本
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
    └── index.js            # WS 客户端 + Claude Code 进程管理 + 对话历史
```

## 🔧 日常管理

### 查看状态

```bash
# 云服务器上
ssh root@你的服务器IP "pm2 status"

# 本地机器上
pm2 status
```

### 查看日志

```bash
# 云服务器
ssh root@你的服务器IP "pm2 logs claude-web-server --lines 20"

# 本地 Agent
pm2 logs claude-web-agent --lines 20
```

### 重启服务

```bash
# 云服务器
ssh root@你的服务器IP "pm2 restart claude-web-server"

# 本地 Agent
pm2 restart claude-web-agent
```

### 更新部署

当有新版本时：

```bash
git pull
bash deploy.sh          # 更新云服务器
# 然后重启本地 Agent
pm2 restart claude-web-agent
```

## ❓ 常见问题

**Q: 网页打开后显示 Agent 离线？**
A: 确保本地 Agent 已启动并连接到云服务器。检查本地网络和防火墙设置。

**Q: 消息发送后没响应？**
A: 检查本地 Agent 日志 `pm2 logs claude-web-agent`，确认 Claude CLI 可用。

**Q: 支持多个设备同时使用吗？**
A: 支持。多个浏览器客户端可以同时连接，每个客户端独立会话（独立 session-id）。

**Q: 移动端如何访问？**
A: 手机浏览器直接打开 `http://你的服务器IP:3000`，界面自动适配移动端。

**Q: 对话历史存在哪里？**
A: 对话历史保存在本地 Agent 的内存中。Agent 重启后历史会丢失，但每次对话的上下文（最近 50 轮）会在对话期间保持。

**Q: 为什么需要云服务器，不能直接连接本地 Agent？**
A: 你的手机/平板和你家里的电脑通常不在同一个网络。云服务器作为中继，让任意网络的设备都能访问到你的本地 Agent。

## 📄 许可证

MIT License — 详见 [LICENSE](LICENSE) 文件。
