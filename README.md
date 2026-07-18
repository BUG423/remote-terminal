# Remote Terminal

通过浏览器访问远端机器上的真实交互式终端。浏览器和 Agent 都主动连接云端中继 Server，Agent 不需要开放 SSH、RDP 或其他入站端口。

![界面截图](docs/images/screenshot.png)

## 适用范围

本项目适合个人或内部受控环境中的远程终端访问：

- 基于 `xterm.js` 和 `node-pty` 的交互式 Shell
- 多会话、切换、分屏、历史回放和刷新恢复
- Agent 断线重连；中继重启期间 PTY 保持运行，受限大小内的离线输出会在重连后补回
- 浏览器与 Agent 角色凭据分离，多设备独立路由
- WSS、HTTP/HTTPS 出口代理和 `NO_PROXY`
- 会话数、浏览器连接数、消息大小和回放缓存上限
- 命令输入审计、私有文件权限和日志轮转

它不是 SSH 的等价安全实现，也不是多租户堡垒机。持有有效 Token 的用户可以操作 Agent 运行账户权限范围内的完整 Shell。

## 架构

```text
浏览器 ── HTTPS/WSS 443 ──┐
                          ├── Nginx ── WS ── Server 127.0.0.1:3002
Agent ─── WSS 443 ────────┘                         │
                                                   │ Token 路由
Agent 上的 node-pty / bash / zsh  <────────────────┘
```

Server 只负责页面、鉴权、路由和有限回放缓存。所有命令都在 Agent 所在机器执行，Agent 不监听公网端口。

对于禁止 SSH 22、向日葵或 ToDesk 的受限服务器，只要它仍被授权主动访问中继 Server 的 WSS 地址（通常是 TCP 443），就可以运行 Agent。若出口必须经过企业代理，可设置 `proxyUrl`、`HTTPS_PROXY` 或 `HTTP_PROXY`。

## 环境要求

- Node.js 20、22 或 24
- Agent 所在 Linux 机器需要可用 Shell
- `node-pty` 没有对应预编译包时，需要 `python3`、`make` 和 C/C++ 编译工具
- 生产入口推荐使用 Nginx 和有效 TLS 证书

## 配置

从示例创建独立配置，不要把真实 Token 提交到 Git：

```bash
cp config.json.example config.json
node -e "for(let i=0;i<2;i++) console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

推荐分别给 Server 和每台 Agent 保存最小配置。

Server 配置：

```json
{
  "port": 3002,
  "bindHost": "127.0.0.1",
  "devices": {
    "production-a": {
      "name": "生产服务器 A",
      "browserToken": "替换为第一个随机Token",
      "agentToken": "替换为另一个不同的随机Token"
    }
  },
  "maxSessions": 12,
  "maxBrowsersPerToken": 8,
  "scrollbackBytes": 262144
}
```

Agent 配置：

```json
{
  "agentToken": "与Server中对应设备的agentToken完全一致",
  "serverUrl": "wss://terminal.example.cn",
  "workspaceRoot": "/srv/remote-terminal-workspace",
  "maxSessions": 12,
  "offlineOutputBytes": 262144,
  "auditEnabled": true,
  "auditLogPath": "/var/log/remote-terminal/audit.log",
  "auditMaxBytes": 10485760,
  "enableLegacyChat": false
}
```

旧版 `tokens` / `token` 配置仍可迁移使用，但同一凭据可同时声明浏览器和 Agent 角色，不能防止浏览器凭据伪装 Agent。新部署应使用 `devices` 双凭据模式。

`workspaceRoot` 只是终端启动目录，不是操作系统沙箱。终端仍能访问 Agent 运行账户有权限访问的其他路径。

## 部署 Server

```bash
git clone https://github.com/BUG423/remote-terminal.git /opt/remote-terminal
cd /opt/remote-terminal/server
npm ci --omit=dev --no-audit --no-fund

CW_CONFIG_PATH=/etc/remote-terminal/server.json \
  pm2 start index.js --name remote-terminal-server --cwd /opt/remote-terminal/server
pm2 save
```

资源受限或安全要求较高的 Linux 服务器，可使用 `deploy/systemd/` 中的两个单元，让 Server 和 Agent 分别以独立低权限账户运行，并施加提权、文件系统、任务数和内存限制。

Node Server 应保持 `127.0.0.1:3002`，只让 Nginx 对外暴露 443。仓库中的 [Nginx 配置](nginx/web-claude.conf)是模板，替换域名和证书路径后再启用：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

前端的 xterm 资源由 Server 本地提供，不依赖公共 CDN。

以后从 GitHub 安全更新现有服务器检出目录：

```bash
SERVER_HOST=服务器地址 \
SERVER_SSH_PORT=822 \
REMOTE_DIR=/opt/remote-terminal \
bash deploy.sh
```

`deploy.sh` 只接受干净的现有 Git 工作区，只做 `origin/main` 快进更新、`npm ci`、PM2 重载和健康检查。它不会上传配置、安装系统包、修改防火墙或覆盖 Nginx。

## 定期监控中继

`deploy/systemd/remote-terminal-monitor.*` 提供无常驻进程的定期监控。Timer 默认每 5 分钟检查：

- Server、Nginx 和内部 `/health`
- Nginx 本机 TLS 页面及证书校验
- 指定远程 Agent 的在线状态和会话数
- 系统负载、可用内存和根分区使用率
- 中继服务器是否误运行了 Remote Terminal Agent

为具体服务器创建 root-only 环境文件：

```bash
sudo install -m 0644 deploy/systemd/remote-terminal-monitor.service /etc/systemd/system/
sudo install -m 0644 deploy/systemd/remote-terminal-monitor.timer /etc/systemd/system/

sudo install -d -m 0711 /etc/remote-terminal
sudo sh -c 'cat > /etc/remote-terminal/monitor.env' <<'EOF'
RT_MONITOR_DEVICE_ID=production-a
RT_MONITOR_TLS_HOST=terminal.example.cn
RT_MONITOR_TLS_PORT=443
RT_MONITOR_AUTO_HEAL=1
RT_MONITOR_ENFORCE_NO_AGENT=1
EOF
sudo chmod 0600 /etc/remote-terminal/monitor.env

sudo systemctl daemon-reload
sudo systemctl start remote-terminal-monitor.service
sudo systemctl enable --now remote-terminal-monitor.timer
```

`RT_MONITOR_AUTO_HEAL=1` 允许在 Server 或 Nginx 停止、内部健康检查失败时执行一次重启。`RT_MONITOR_ENFORCE_NO_AGENT=1` 用于纯中继主机：它会禁用本机 Agent 单元，并终止该主机上的 Remote Terminal Agent 进程；远程 Agent 离线时只记录严重状态，绝不会在中继主机启动替代 Agent。

查看最新状态、执行日志和下一次运行时间：

```bash
sudo cat /var/lib/remote-terminal-monitor/status.json
sudo journalctl -u remote-terminal-monitor.service -n 50 --no-pager
systemctl list-timers remote-terminal-monitor.timer --no-pager
```

状态文件不包含 Token。正常业务异常写入状态文件和 journald；监控程序自身崩溃才会让 oneshot 单元失败。

## 运行 Agent

```bash
cd /opt/remote-terminal/agent
npm ci --no-audit --no-fund

CW_CONFIG_PATH=/etc/remote-terminal/agent.json \
  pm2 start index.js --name remote-terminal-agent --cwd /opt/remote-terminal/agent
pm2 save
```

受限网络通过显式代理连接：

```json
{
  "serverUrl": "wss://terminal.example.cn",
  "proxyUrl": "http://proxy.internal:8080",
  "noProxy": "localhost,127.0.0.1,.internal.example.cn"
}
```

也可以使用标准环境变量：

```bash
HTTPS_PROXY=http://proxy.internal:8080 \
NO_PROXY=localhost,127.0.0.1 \
CW_CONFIG_PATH=/etc/remote-terminal/agent.json \
node index.js
```

TLS 证书默认严格校验。私有 CA 可通过 Agent 配置中的 `tlsCaPath` 指定，不应关闭证书校验。

## 环境变量

| 变量 | 作用 |
|---|---|
| `CW_CONFIG_PATH` | 指定 Server 或 Agent 配置文件 |
| `CLAUDE_WEB_TOKEN` | 覆盖 Agent Token；Server 使用时启用旧共享 Token 兼容模式 |
| `CW_SERVER_URL` | 覆盖 Agent 的完整 `ws://` / `wss://` 地址 |
| `HTTPS_PROXY` / `HTTP_PROXY` | Agent 出口代理 |
| `NO_PROXY` | 绕过代理的主机、后缀或端口列表 |
| `CW_MAX_SESSIONS` | 每个 Agent 的最大会话数 |
| `CW_MAX_BROWSERS_PER_TOKEN` | 每 Token 最大浏览器连接数 |
| `CW_OFFLINE_OUTPUT_BYTES` | Agent 每会话离线输出缓冲上限 |
| `CW_SCROLLBACK_BYTES` | Server 每会话历史回放上限 |
| `CW_AUDIT_LOG` | 审计日志路径 |
| `CW_AUDIT_ENABLED=false` | 关闭命令输入审计 |

## 服务器测试

测试脚本会临时启动真实 Server、真实 Agent 和真实 PTY，并在完成后清理进程及端口：

```bash
cd /opt/remote-terminal
cd server && npm ci --no-audit --no-fund
cd ../agent && npm ci --no-audit --no-fund
cd ..
bash scripts/run-server-tests.sh
```

覆盖范围包括：

- 会话状态、重复 ID、并发切换和边界条件
- Token 鉴权、隔离、重复鉴权、暴力尝试和认证超时
- 消息大小、会话上限、浏览器连接上限和恶意 Agent 数据
- 真实终端创建、输入、回放、删除和长任务
- Server 实际停止并重启后的 Agent 重连、PTY 存活和离线输出补回
- 审计日志权限与轮转、测试进程和监听端口清理

## 安全要求

- 必须使用有效 HTTPS/WSS，不要通过公网明文 `ws://` 使用。
- Agent 应使用专用低权限系统账户；不要以 root 运行，除非明确需要完整 root 终端。
- 浏览器和 Agent Token 都至少 32 个随机字符，必须彼此不同，并按设备独立分配、定期轮换。
- `config.json`、代理凭据和审计日志都应限制为仅运行账户可读。
- 审计日志会记录终端输入，可能包含密钥、密码或其他敏感命令参数。
- 高风险生产环境应进一步使用容器、systemd 沙箱、主机防火墙、设备证书或 mTLS。
- 当前 Server 是单节点内存状态，不提供集群、高可用或跨节点会话迁移。

## 许可证

MIT，见 [LICENSE](LICENSE)。
