#!/usr/bin/env node
/**
 * Custom ACP entry point that patches ClaudeAcpAgent to support:
 * - Model selection via session/new params (uses setModel() after session creation)
 * - Real token usage and USD cost from SDKResultSuccess (via query.next interception)
 *
 * Used instead of the default @zed-industries/claude-agent-acp entry point.
 */

// Redirect console to stderr (same as original)
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

process.on('unhandledRejection', (reason) => {
  console.error(`[patched-acp] unhandledRejection: ${reason}`);
});
process.on('uncaughtException', (err) => {
  console.error(`[patched-acp] uncaughtException: ${err.message}\n${err.stack}`);
});

console.error(`[patched-acp] Importing ClaudeAcpAgent...`);
import { ClaudeAcpAgent, runAcp } from "@zed-industries/claude-agent-acp/dist/acp-agent.js";
console.error(`[patched-acp] Import done. Env: ANTHROPIC_BASE_URL=${process.env.ANTHROPIC_BASE_URL}, ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY ? "(set)" : "(unset)"}, NODE_ENV=${process.env.NODE_ENV}`);
console.error(`[patched-acp] runAcp starting...`);

// Patch newSession to:
// 1. Pass model via setModel() after session creation
// 2. Wrap query.next() to capture real cost/usage from SDKResultSuccess messages
const originalNewSession = ClaudeAcpAgent.prototype.newSession;
ClaudeAcpAgent.prototype.newSession = async function (params) {
  const result = await originalNewSession.call(this, params);

  const session = this.sessions?.[result.sessionId];

  // Wrap query.next() to intercept SDKResultSuccess and capture cost/usage.
  // The SDK result message has total_cost_usd and usage (input_tokens, output_tokens, etc.)
  // but acp-agent.js drops them and only returns { stopReason }. We capture them here
  // so that our patched prompt() can attach them to the response.
  if (session?.query) {
    const originalNext = session.query.next.bind(session.query);
    session.query.next = async function (...args) {
      console.error(`[patched-acp] query.next() called`); const start = Date.now();
      const item = await originalNext(...args);
      console.error(`[patched-acp] query.next() returned after ${Date.now()-start}ms type=${item?.value?.type} subtype=${item?.value?.subtype}`);
      if (
        item.value?.type === "result" &&
        item.value?.subtype === "success"
      ) {
        // total_cost_usd is the CUMULATIVE session cost, not per-turn.
        // We must compute the delta so Firebase increments are per-turn only.
        const prevSessionCost = session._sessionCostUsd ?? 0;
        session._lastCostUsd = item.value.total_cost_usd - prevSessionCost;
        session._sessionCostUsd = item.value.total_cost_usd;
        session._lastUsage = item.value.usage;
        session._lastModelUsage = item.value.modelUsage;
      }
      return item;
    };
  }

  return result;
};

// Patch prompt() to attach captured cost/usage to the return value.
// The ACP PromptResponse supports usage (experimental) and _meta for extras.
const originalPrompt = ClaudeAcpAgent.prototype.prompt;
ClaudeAcpAgent.prototype.prompt = async function (params) {
  console.error(`[patched-acp] prompt() called sessionId=${params.sessionId} prompt_len=${JSON.stringify(params.prompt).length}`);
  try {
    const result = await originalPrompt.call(this, params);
    console.error(`[patched-acp] prompt() resolved stopReason=${result?.stopReason}`);

    const session = this.sessions?.[params.sessionId];
    if (session?._lastCostUsd !== undefined) {
      const u = session._lastUsage ?? {};
      const inputTokens = u.input_tokens ?? 0;
      const outputTokens = u.output_tokens ?? 0;
      const cacheRead = u.cache_read_input_tokens ?? 0;
      const cacheWrite = u.cache_creation_input_tokens ?? 0;
      const costUsd = session._lastCostUsd;
      const totalTokens = inputTokens + cacheWrite + cacheRead + outputTokens;
      const modelKeys = Object.keys(session._lastModelUsage ?? {});
      console.error(
        `[patched-acp] Usage: model=${modelKeys.join(",") || "unknown"}, cost=$${costUsd}, ` +
        `input=${inputTokens}, output=${outputTokens}, ` +
        `cacheWrite=${cacheWrite}, cacheRead=${cacheRead}, total=${totalTokens}`
      );
      const augmented = {
        ...result,
        usage: { inputTokens, outputTokens, cachedReadTokens: cacheRead, cachedWriteTokens: cacheWrite, totalTokens },
        _meta: { costUsd },
      };
      delete session._lastCostUsd;
      delete session._lastUsage;
      delete session._lastModelUsage;
      return augmented;
    }

    return result;
  } catch (err) {
    console.error(`[patched-acp] prompt() rejected: ${err.message}`);
    throw err;
  }
};

// Run the (now patched) ACP agent
try {
  runAcp();
} catch (err) {
  console.error(`[patched-acp] runAcp threw: ${err.message}`);
}

// Keep process alive
process.stdin.resume();
