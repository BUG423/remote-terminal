# 改进日志 — 三大问题修复

## 📋 概述

本次更新修复了三个重要问题：粘贴富文本显示为图片、Agent重启后会话丢失、日志记录不完善。

---

## ✅ 问题1：粘贴显示为图片 — 已修复

### 问题描述
- 通过语音识别（豆包等）粘贴内容时，在Web-Claude终端显示为图片(MG格式)而非文本
- 需要使用 `Ctrl+Shift+V` 才能粘贴为纯文本

### 根本原因
xterm.js默认保留剪贴板的格式，包括富文本和图片。

### 解决方案
在`server/public/app.js`中拦截粘贴事件，从剪贴板提取纯文本`text/plain`，过滤掉所有富文本和图片数据。

### 代码位置
- 文件：`server/public/app.js`，第218-230行
- 关键方法：`container.addEventListener('paste', ...)`

### 使用效果
- ✅ 粘贴任何内容都只会发送纯文本
- ✅ 支持语音识别、复制粘贴、拖拽等多种输入方式
- ✅ 自动转换富文本和图片为纯文本

---

## ✅ 问题2：会话恢复 — 已修复

### 问题描述
- Agent或Server重启后，前端显示会话列表为空
- 用户需要重新新建会话，无法复用之前的工作目录

### 根本原因
Agent启动时没有扫描已存在的工作目录来恢复会话状态。

### 解决方案

#### Step 1: 会话元数据持久化（session-manager.js）
- 新增`saveSessionMetadata(session)`函数
- 在每个工作目录下保存`.session.json`，记录sessionId、title、cwd等元数据
- 这样重启后可以恢复准确的会话身份

#### Step 2: 会话扫描与恢复（session-manager.js）
- 新增`recoverSessions()`函数
- 启动时扫描`WORKSPACE_ROOT`目录
- 对于每个已存在的子目录，读取`.session.json`恢复会话元数据
- 将恢复的会话记录为`status='recovered'`（无活跃PTY）

#### Step 3: Agent启动时调用恢复（agent/index.js）
- 认证成功后立即调用`sessionManager.recoverSessions()`
- 向Server报告已恢复的会话，前端立即显示

#### Step 4: 激活已恢复会话（agent/index.js）
- 当前端点击已恢复的会话时，自动为其创建新的PTY
- 会话状态从`recovered`变为`running`
- 用户可以继续在原工作目录中工作

### 代码位置
- 文件：`agent/session-manager.js`
  - `saveSessionMetadata()` — 第155-168行
  - `recoverSessions()` — 第171-225行
- 文件：`agent/index.js`
  - 认证成功时调用recover — 第183-191行
  - 激活已恢复会话 — 第286-324行

### 使用效果
```
场景：Agent重启
before: 前端会话列表空空如也
after: 前端自动显示之前的会话（status='recovered'），点击即可激活并继续工作
```

### 关键特性
- ✅ 每个会话自动保存元数据到`.session.json`
- ✅ Agent启动时自动扫描并恢复已有目录
- ✅ 前端显示所有恢复的会话，可直接点击激活
- ✅ 激活时自动创建新PTY，历史文件完整保留
- ✅ 支持`recovered`状态会话和`running`状态会话混合显示

---

## ✅ 问题3：日志记录不完善 — 已修复

### 问题描述
- Agent和Server的心跳日志不详细，难以调试连接问题
- 无法追踪半开连接(half-open)的检测过程

### 解决方案

#### Step 1: 创建日志模块（logger.js）
- 新增`logger.js`，提供统一的日志接口
- 自动记录到`~/.claude-web-logs/agent-YYYY-MM-DD.log`和`server-YYYY-MM-DD.log`
- 支持多个日志级别：`debug`, `info`, `warn`, `error`, `heartbeat`, `connection`
- 每条日志包含时间戳、级别、消息、结构化数据

#### Step 2: Agent日志增强（agent/index.js）
**启动**
- 初始化日志，记录配置（服务器IP、工作目录等）

**连接**
- 记录连接开始、连接成功、认证成功
- 记录会话恢复数量和详情

**心跳**
- 定期记录心跳ping发送时间
- 记录pong接收时间和延迟
- 记录死连接检测结果

**断开**
- 记录断开原因和code
- 重连前记录延迟和重试次数

#### Step 3: Server日志增强（server/index.js）
**启动与关闭**
- 启动时记录监听端口
- 关闭时记录优雅关闭

**连接管理**
- 新连接记录ClientID和来源IP
- Agent连接时记录Agent的ClientID
- 旧Agent被新Agent接管时记录

**心跳检测**
- 定期发送ping并记录
- 记录pong接收确认
- 记录死连接检测和清理

### 代码位置
- 文件：`logger.js` — 完整的日志模块实现
- 文件：`agent/index.js`
  - 初始化日志 — 第20-21行
  - 心跳检测 — 第115-133行
  - 死连接检测 — `checkDeadConnection()`函数
- 文件：`server/index.js`
  - 初始化日志 — 第24-25行
  - 心跳定时器 — 第265-309行
  - 连接日志 — 多处connection级别日志

### 日志文件位置
```
~/.claude-web-logs/
├── agent-2026-06-13.log      # Agent日志（按日期归档）
└── server-2026-06-13.log     # Server日志（按日期归档）
```

### 查看日志
```bash
# 实时跟踪Agent日志
tail -f ~/.claude-web-logs/agent-$(date +%Y-%m-%d).log

# 实时跟踪Server日志
tail -f ~/.claude-web-logs/server-$(date +%Y-%m-%d).log

# 查找特定时间的日志
grep "2026-06-13 14:3" ~/.claude-web-logs/agent-*.log

# 查找所有心跳相关日志
grep "HEARTBEAT" ~/.claude-web-logs/agent-*.log

# 查找连接问题
grep "CONNECTION" ~/.claude-web-logs/agent-*.log
```

### 使用效果
```
Agent日志示例：
[2026-06-13T14:30:45.123Z] [INFO] Agent 启动 | {"serverHost":"8.138.246.166","serverPort":3000}
[2026-06-13T14:30:46.456Z] [CONNECTION] 已连接到服务器
[2026-06-13T14:30:47.789Z] [INFO] Agent 认证成功
[2026-06-13T14:30:47.890Z] [INFO] 已恢复 3 个会话目录 | {"count":3}
[2026-06-13T14:30:50.000Z] [HEARTBEAT] 发送 heartbeat ping | {"sentAt":1718370650000}
[2026-06-13T14:30:50.050Z] [HEARTBEAT] 收到 pong | {"lastPongAtMs":1718370650050}
```

### 关键特性
- ✅ 自动按日期创建日志文件
- ✅ 结构化日志，便于搜索和分析
- ✅ 心跳、连接、错误等多维度记录
- ✅ 时间戳精确到毫秒
- ✅ Server和Agent日志分离，互不干扰

---

## 🚀 升级步骤

### 无需额外配置
所有改进都在代码中实现，**无需修改config.json或环境变量**。

### 自动生效
1. 重启Agent：`pm2 restart claude-web-agent` 或 `node agent/index.js`
2. 重启Server：`pm2 restart claude-web-server` 或 `node server/index.js`
3. 前端自动刷新获得新功能

### 验证改进

**1. 粘贴功能**
```
尝试用语音识别或任何方式粘贴内容，应该显示纯文本而非图片
Ctrl+V 和 Ctrl+Shift+V 效果一致
```

**2. 会话恢复**
```
1. 启动Agent，创建几个会话，执行一些命令
2. 关闭Agent（或Server）
3. 重新启动Agent
4. 前端应自动显示之前的会话（status='recovered'）
5. 点击会话，应自动为其创建新PTY并回到工作目录
```

**3. 日志记录**
```
tail -f ~/.claude-web-logs/agent-$(date +%Y-%m-%d).log
# 应看到启动、恢复、心跳等详细日志

ps aux | grep [a]gent
# 检查心跳和死连接检测过程
```

---

## 📊 技术细节

### 粘贴事件处理
```javascript
// 使用 paste 事件的 capturing 阶段捕获
// 从 clipboardData 中提取 text/plain
// 忽略所有其他MIME类型（image/*, text/html等）
container.addEventListener('paste', (e) => {
  const text = e.clipboardData?.getData('text/plain');
  if (text) {
    term.write(text);
    sendWS({ type: 'terminal_input', sessionId, data: text });
  }
}, true);
```

### 会话恢复流程
```
Agent启动 → 认证成功 → recoverSessions()
  ↓
遍历WORKSPACE_ROOT目录
  ↓
对每个子目录读取.session.json
  ↓
恢复sessionId和元数据
  ↓
报告给Server → 广播给前端显示
  ↓
用户点击会话 → onTerminalCreate()检测status='recovered'
  ↓
为已恢复会话创建新PTY，status更新为'running'
```

### 日志收集架构
```
logger.js (统一接口)
  ↓
按角色(agent/server)区分
  ↓
按日期自动归档到 ~/.claude-web-logs/
  ↓
日志格式：[ISO时间] [级别] 消息 | JSON数据
```

---

## ⚠️ 注意事项

1. **日志文件大小**：每个进程每天可生成数MB日志，建议定期清理旧日志
   ```bash
   # 清理7天前的日志
   find ~/.claude-web-logs -name "*.log" -mtime +7 -delete
   ```

2. **会话元数据**：`.session.json`存放在工作目录中，删除会话时如勾选"删除工作目录文件"会一并删除
   
3. **粘贴输入**：`text/plain`提取时会保留换行符(`\n`)，符合终端预期

4. **已恢复会话的PTY**：即使没有激活（点击），已恢复会话也会在列表显示，前端可以选择激活时机

---

## 🔄 相关改进

这次更新与之前的改进(f6da58f)互补：
- **f6da58f**：心跳/死连接检测算法本身
- **本次**：心跳/死连接的详细日志记录，便于监控和调试

---

## 📝 示例使用场景

### 场景1：远程语音输入
```
用户(手机):  Alt+F(豆包语音) → "ls -la" → 插入
Web-Claude:  纯文本显示"ls -la"，无图片问题
终端输出:    目录列表
```

### 场景2：电脑重启后恢复工作
```
用户:        关闭笔记本 → 重启
Web-Claude:  刷新浏览器
前端:        自动显示之前的3个会话（status='recovered'）
用户:        点击"项目-A"会话
Agent:       为该会话创建新PTY，加载原工作目录
用户:        继续工作（所有文件都还在）
```

### 场景3：调试连接问题
```
问题:        Agent连接不稳定，频繁掉线
排查:        tail -f ~/.claude-web-logs/agent-*.log
日志:        看到超过70s没收到pong，检测到dead connection
原因:        网络延迟或防火墙设置
修复:        调整PONG_TIMEOUT_MS或检查网络
```

---

## 📞 反馈与后续改进

如遇问题，请查看：
1. `~/.claude-web-logs/` 中的日志文件
2. `config.json` 中的token和服务器IP
3. 确保Server和Agent都已启动，且能相互连接

