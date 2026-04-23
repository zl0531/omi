# 本地化开发：Graceful Degradation 与 Wanqing LLM 集成

## 一、Graceful Degradation（优雅降级）

### 1.1 什么是 Graceful Degradation

Graceful degradation 是一种系统设计原则：**当某个依赖组件不可用时，系统不是直接崩溃，而是以降低功能体验的方式继续运行**。

在这个项目中，外部依赖有两层：
- **GCP/Firestore** — 用于用户数据持久化（聊天记录、Goal、Memory 等）
- **Google/Apple 登录** — 用于用户身份认证

理想情况下需要 GCP credentials 才能完整运行。但本地开发时，我们希望**跳过这些依赖，系统仍能基本可用**。

### 1.2 架构设计：三段式降级

```
┌─────────────────────────────────────────────────────┐
│                    Swift App                        │
│  (AuthState, ChatProvider, AgentVMService, ...)     │
└──────────────┬──────────────────────────────────────┘
               │
               │ dev-token / auth_userId=dev-user
               ▼
┌─────────────────────────────────────────────────────┐
│              Rust Backend (Axum)                    │
│  ├── auth.rs        — "dev-token" 直接返回 dev-user │
│  ├── firestore.rs   — is_available() guard          │
│  ├── agent.rs       — 503 早退，不尝试 VM provision│
│  ├── chat_sessions  — 无 Firestore → 返回 [] / 本地 │
│  └── messages.rs    — 无 Firestore → 返回 [] / 本地 │
└──────────────┬──────────────────────────────────────┘
               │
               │ (GCP credentials optional)
               ▼
┌─────────────────────────────────────────────────────┐
│           Google Cloud Firestore                    │
│         (无凭证时所有操作变成 no-op)               │
└─────────────────────────────────────────────────────┘
```

### 1.3 三处 Graceful Degradation 实现

#### 第一段：Auth — 开发模式直接放行

```swift
// AuthService.swift
func getIdToken(forceRefresh: Bool = false) async throws -> String {
    if shouldSkipAuth() {           // --dev-auth 或 UserDefaults dev-user
        return "dev-token"           // 不走 Firebase Auth
    }
    // ... 正常 Firebase 流程
}
```

```swift
// OmiApp.swift
func shouldSkipAuth() -> Bool {
    if CommandLine.arguments.contains("--dev-auth") { return true }
    if UserDefaults.standard.string(forKey: "auth_userId") == "dev-user" { return true }
    return false
}
```

AuthState 初始化时检测到 dev 模式，直接写 UserDefaults signed-in 状态，不需要真实登录。

#### 第二段：Rust Backend — Firestore no-op

```rust
// firestore.rs
pub fn is_available(&self) -> bool {
    self.credentials.is_some()   // 有 GCP service account key 才可用
}

// 所有 Firestore 操作：
pub async fn get_chat_sessions(&self, uid: &str, ...) -> Result<Vec<...>, ...> {
    if self.credentials.is_none() {
        return Ok(vec![]);       // 返回空列表，不报错
    }
    // ... 正常 Firestore 逻辑
}
```

这样设计的好处：**路由处理器不需要关心底层是否有 Firestore**，统一由 service 层处理。

```rust
// chat_sessions.rs
async fn get_chat_sessions(...) -> Result<Json<Vec<...>>, StatusCode> {
    if !state.firestore.is_available() {
        return Ok(Json(vec![]));  // Rust 路由层完全不知道 Firestore 存在与否
    }
    // ...
}
```

#### 第三段：Agent VM — 503 早退

```swift
// AgentVMService.swift (Swift)
do {
    let status = try await APIClient.shared.getAgentStatus()
    // ...
} catch let error as APIError {
    if case .httpError(let statusCode) = error, statusCode == 503 {
        return  // Backend 告知 Firestore 不可用，直接跳过 VM provision
    }
}
```

```rust
// agent.rs (Rust)
async fn get_agent_status(...) -> Result<Json<...>, StatusCode> {
    if !state.firestore.is_available() {
        return Ok(Json(None));   // Swift 收到 503，不尝试 provision
    }
    // ...
}
```

### 1.4 降级收益

| 功能 | 有 GCP Credentials | 无 GCP Credentials |
|------|-------------------|-------------------|
| 登录认证 | Firebase Auth (Google/Apple) | dev-token bypass |
| 聊天记录 | Firestore 持久化 | 内存/session 级别（这次改动未做本地持久化）|
| Agent VM | GCP VM provision | 503 跳过，App 不报错 |
| Firestore 写 | 正常写入 | 空操作（静默成功）|
| Firestore 读 | 正常读取 | 返回 `[]` |

---

## 二、Wanqing LLM 集成：确保使用指定模型

### 2.1 问题背景

项目支持多种 LLM Provider。Wanqing 是快手内部 LLM 服务，需要指定模型 ID（类似 `ep-u9c7ra-1776309766497075165`）才能正确路由。

**核心问题**：当 Swift 端发送聊天请求时，bridge 层的 session 可能复用，但 Swift **不传 model 字段**（`msg.model = nil`）。此时如果 bridge 端 fallback 到默认模型 `claude-sonnet-4-6`，而该模型不在 Wanqing provider 上，API 请求就会挂住。

### 2.2 路由链：Swift → ACPBridge → Node subprocess

```
Swift ChatProvider
  │
  │ query(model: nil, sessionKey: "main", ...)
  ▼
ACPBridge.swift (Swift Process)
  │
  │ stdin: JSON { model: (model ?? modelOverride) ?? nil }
  │ env: ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY
  ▼
Node.js subprocess (acp-bridge/index.ts)
  │
  │ handleQuery(msg)
  │   → resolveSession(sessions, sessionKey, cwd)
  │     → session found (pre-warmed on Wanqing model)
  │   → needsModelUpdate(existing, ???)  ← 关键
  ▼
Claude Agent SDK (patched-acp-entry.mjs)
  │
  │ session/prompt → Wanqing API
  ▼
```

### 2.3 模型决定的三层逻辑

#### 第一层：Swift — 传什么 model？

```swift
// ChatProvider.swift
model: (model ?? modelOverride) ?? nil
// 如果 model 和 modelOverride 都为 nil，传的就是 nil 而不是 "some empty string"
```

#### 第二层：ACP Bridge — sessionKey 和 requestedModel

```typescript
// index.ts handleQuery()
const requestedModel = msg.model || DEFAULT_MODEL;   // msg.model=nil → "claude-sonnet-4-6"
const sessionKey = msg.sessionKey ?? requestedModel; // sessionKey="main"

// pre-warm 时创建的 sessionKey 是模型名（如 "ep-u9c7ra-..."）
// 查询时 Swift 传 sessionKey="main"，但 pre-warmed session 实际存在 "ep-u9c7ra-..." key 下
// → resolveSession() 找不到，sessionKey fallback 到 requestedModel
```

#### 第三层：Session 复用时 — 关键 bug 和修复

**修复前（bug 代码）**：
```typescript
// index.ts
if (needsModelUpdate(resolved?.existing, requestedModel)) {
    // requestedModel = "claude-sonnet-4-6"（来自 msg.model || DEFAULT_MODEL）
    // existing.model = "ep-u9c7ra-..."（pre-warm 时设置的 Wanqing 模型）
    // → needsModelUpdate = true → 触发 session/set_model 切换到 Sonnet
    // → Sonnet 不在 Wanqing provider 上 → API 请求挂住
    await acpRequest("session/set_model", { sessionId, modelId: requestedModel });
}
```

**修复后**：
```typescript
// session-manager.ts
export function needsModelUpdate(
    existing: SessionEntry | undefined,
    requestedModel: string | undefined
): boolean {
    if (!existing || !requestedModel) return false;  // 关键：任一为空就不更新
    return requestedModel !== existing.model;
}

// index.ts
if (needsModelUpdate(resolved?.existing, undefined)) {
    // 复用 session 时传 undefined，而不是 fallback 的 DEFAULT_MODEL
    // → needsModelUpdate = false（因为 requestedModel=undefined）
    // → 不调用 session/set_model
    // → session 保持 pre-warm 时设置的 Wanqing 模型
}
```

**为什么这样有效**：
- Pre-warm 阶段：用 Wanqing 模型 `ep-u9c7ra-...` 创建 session，并 `sessions.set(sessionKey, { ..., model: "ep-u9c7ra-..." })`
- Query 阶段：Swift 没传 model，`requestedModel` 虽然被计算为 `DEFAULT_MODEL`，但我们**故意不传**给 `needsModelUpdate`
- 结果：`needsModelUpdate(existing=有值, requestedModel=undefined)` → `false` → 保留 session 原模型

### 2.4 Wanqing 环境变量配置

ACPBridge.swift 启动 Node subprocess 时注入环境变量：

```swift
// ACPBridge.swift
if UserDefaults.standard.bool(forKey: "useWanqingLLM") {
    if let key = APIKeyService.currentWanqingKey {
        env["ANTHROPIC_API_KEY"] = key
    }
    env["ANTHROPIC_BASE_URL"] = "https://wanqing-api.corp.kuaishou.com/api/gateway"
}
```

`patched-acp-entry.mjs` 在 import 时打印确认：

```javascript
console.error(`[patched-acp] Import done. Env: ANTHROPIC_BASE_URL=${process.env.ANTHROPIC_BASE_URL}, ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY ? "(set)" : "(unset)"}`);
```

### 2.5 调试技巧：怎么快速判断问题在哪一层

| 现象 | 可能在哪个环节 |
|------|---------------|
| `prompt()` 没被调用 | ACPBridge subprocess 未启动 / stdin/stdout pipe 断 |
| `prompt()` 调用了但 `query.next()` 挂住 | API 请求发出去了但没响应（模型/路由/凭证问题）|
| `query.next()` 返回 `hook_started` 后直接 `init` | 正常，hooks 阶段 |
| `session/set_model` 被调用且模型变成 Sonnet | **第三层 bug**：session 复用时错误切换了模型 |
| API 返回 401/403 | `ANTHROPIC_API_KEY` 未正确传入 subprocess |
| API 路由 404 | `ANTHROPIC_BASE_URL` 少了 `/v1/` 或多了 `/v1/` |

### 2.6 经验总结：模型选择的安全原则

**原则：Session 复用时，不传 model 意味着"保持现状"，不要主动切换。**

```typescript
// 错误：fallback 到默认模型，覆盖了 pre-warm 时精心选择的模型
const requestedModel = msg.model || DEFAULT_MODEL;
needsModelUpdate(existing, requestedModel);  // 总是有值

// 正确：复用 session 时，模型选择权交给 session 自身
const requestedModel = msg.model || DEFAULT_MODEL;  // 仅用于新建 session
if (isReusingSession) {
    needsModelUpdate(existing, undefined);     // 告诉函数"不要切换"
} else {
    needsModelUpdate(existing, requestedModel);
}
```

这个原则在多模型、多 provider 的场景下尤为重要——每次模型切换都有成本（延迟、可能失败），且切换到错误 provider 上的模型会导致静默挂起。
