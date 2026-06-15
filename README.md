# Web-Claude

浏览器远程控制终端 —— 在任何设备的浏览器里操作你的电脑终端。

## 怎么用

```
你 ──浏览器──→ 云服务器 (Server) ←── 你的电脑 (Agent)
                 webclaude.xmu-zss.cn     运行 claude-web-agent
```

**Server 放云上，Agent 跑在你电脑上。** 浏览器打开网页 → 输入 Token → 就能操作你电脑的终端。

## 安装

### 1. 云服务器部署 Server

```bash
# 前提：安全组放行 3000 端口
git clone https://github.com/BUG423/Web-Claude.git
cd Web-Claude
cp config.json.example config.json
# 编辑 config.json：填你的 tokens、serverHost 改 IP

# 上传到服务器
SERVER_HOST=你的IP SERVER_SSH_PORT=22 bash deploy.sh

# 如果有域名，获取 SSL 证书：
ssh root "certbot --nginx -d 你的域名"
```

### 2. 本地启动 Agent

```bash
cd Web-Claude
cp config.json.example config.json
# config.json：serverHost 填服务器 IP，从 tokens 里挑一个
cd agent && npm install
CW_USE_WSS=true node index.js   # HTTPS 用 WSS

# 或一键启动
CW_USE_WSS=true bash start-local.sh
```

### 3. 打开浏览器

```
https://你的域名:3000      （有 HTTPS）
http://服务器IP:3000       （无 HTTPS）
```

输入 Token → 点击 ＋ 新建会话 → 在终端里操作你的电脑。

## 配置说明

```jsonc
{
  "port": 3002,                    // Server 内部端口（Nginx 后背）
  "bindHost": "127.0.0.1",        // 只本机，Nginx 对外
  "tokens": {                     // Token → 设备名
    "你的token1": "办公室电脑",
    "你的token2": "家里笔记本"
  },
  "serverHost": "服务器IP或域名",   // Agent 连哪里
  "serverPort": 3000,              // 对外端口（Nginx 端口）
  "useTLS": false,                 // Nginx 管 TLS，这里关掉
  "workspaceRoot": "~/WebClaudeWorkspaces"
}
```

生成 Token：`node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`

## 注意

- **只在你电脑上跑 Agent**，不要在云服务器上同时跑 Agent
- **同一时间一个 Server 只接一个 Agent**
- config.json 含 Token，已 gitignore，不会上传

## 开发

```bash
# 本地同时跑 Server 和 Agent 测试
cd server && npm install && node index.js    # http://localhost:3002
cd agent && npm install && node index.js     # 连 ws://localhost:3002
```
