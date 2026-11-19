import os from 'node:os';
import path from 'node:path';
import { createSdkMcpServer, query, tool, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { DISALLOWED_TOOLS } from '../authority.ts';
import { EFFORTS, type Effort, type EngineInfo, type UsageWindow } from '../../../../shared/contract.ts';
import type { ContextReading, Engine, EngineEvent, EngineTurn, RunOptions } from './types.ts';

/**
 * The real engine: Claude Code, driven through the Claude Agent SDK.
 *
 * It launches the `claude` installed on this Mac under the account the owner signed in to
 * (optionally another account's CLAUDE_CONFIG_DIR per member of staff). The server never reads
 * or handles credentials. This is the same arrangement T3 Code uses.
 */

/** Variables that tie a child process to the Claude Code session that launched this server. */
const SESSION_ENV = [
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_PID', 'CLAUDE_EFFORT',
];

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * The environment a staff member's `claude` starts with.
 *
 * Which account it runs on is decided here and nowhere else: the staff member's own account
 * folder if the owner gave them one, otherwise the office's (BUREAU_CLAUDE_CONFIG_DIR), otherwise
 * this Mac's ordinary sign-in. A CLAUDE_CONFIG_DIR that happens to be set in the shell that
 * started the server is dropped, so the account does not depend on where the office was started.
 */
export function childEnv(
  configDir: string | null,
  opts: { connectors?: boolean; officeConfigDir?: string | null; base?: Record<string, string | undefined> } = {},
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...(opts.base ?? process.env) };
  for (const k of SESSION_ENV) delete env[k];
  delete env.CLAUDE_CONFIG_DIR;
  const dir = configDir || opts.officeConfigDir || null;
  if (dir) env.CLAUDE_CONFIG_DIR = expandHome(dir);
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'bureau/0.1';
  // Staff keep their memory in notes/memory.md in their own folder. Claude Code's own memory
  // folder is outside it, so the gate refuses writes there and staff concluded they could not
  // save anything at all.
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  // The apps the owner connected to their Claude account (Gmail, Calendar, Drive and so on) are
  // off by default for programs that drive Claude Code. This is Claude Code's own switch for them.
  if (opts.connectors) env.ENABLE_CLAUDEAI_MCP_SERVERS = '1';
  return env;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ClaudeEngine implements Engine {
  readonly name = 'claude';
  private claudePath: string | null;

  /** The office's account folder; null means this Mac's ordinary Claude Code sign-in. */
  private officeConfigDir: string | null;

  constructor(opts: { claudePath: string | null; configDir?: string | null }) {
    this.claudePath = opts.claudePath;
    this.officeConfigDir = opts.configDir ?? null;
  }

  run(o: RunOptions): EngineTurn {
    const abort = new AbortController();
    let release!: () => void;
    const finished = new Promise<void>((res) => { release = res; });
    const stderrTail: string[] = [];

    const server = createSdkMcpServer({
      name: 'bureau',
      version: '0.1.0',
      instructions: 'Tools of the office: the Desk, signatures, questions for the owner, and colleagues.',
      tools: o.tools.map((t) => tool(t.name, t.description, t.shape, async (args) => {
        try {
          return { content: [{ type: 'text' as const, text: await t.run(args) }] };
        } catch (e) {
          return { content: [{ type: 'text' as const, text: `That did not work: ${(e as Error).message}` }], isError: true };
        }
      })),
    });

    async function* input(): AsyncIterable<SDKUserMessage> {
      yield { type: 'user', message: { role: 'user', content: o.prompt }, parent_tool_use_id: null } as SDKUserMessage;
      // Keep the input open until the turn has produced its result; closing it early ends the session.
      await finished;
    }

    const options: Options = {
      cwd: o.cwd,
      additionalDirectories: o.extraDirs,
      model: o.model ?? undefined,
      effort: o.effort ?? undefined,
      resume: o.sessionId ?? undefined,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: o.systemAppend },
      // Only the staff member's own folder contributes settings and CLAUDE.md. The owner's personal
      // Claude Code hooks, permission rules and skills stay out of the office.
      settingSources: ['project'],
      // Where Claude Code compacts the conversation. The owner's own settings file is not read here, so it is passed in.
      ...(o.compactWindow ? { settings: { autoCompactWindow: o.compactWindow } } : {}),
      mcpServers: { bureau: server },
      disallowedTools: DISALLOWED_TOOLS,
      permissionMode: 'default',
      includePartialMessages: true,
      env: childEnv(o.configDir, { connectors: true, officeConfigDir: this.officeConfigDir }),
      abortController: abort,
      pathToClaudeCodeExecutable: this.claudePath ?? undefined,
      stderr: (d) => { stderrTail.push(d); if (stderrTail.length > 40) stderrTail.shift(); },
      hooks: {
        // The authority gate. A hook sees every tool call, whatever Claude Code's own rules say.
        PreToolUse: [{
          hooks: [async (hookInput) => {
            if (hookInput.hook_event_name !== 'PreToolUse') return {};
            const verdict = o.gate.check(hookInput.tool_name, hookInput.tool_input, hookInput.tool_use_id);
            if (verdict.outcome === 'deny') {
              return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: verdict.message } };
            }
            return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: verdict.outcome === 'allow' ? 'allow' : 'ask' } };
          }],
        }],
      },
      // Calls the gate marked "ask" arrive here and wait for a signature, however long that takes.
      canUseTool: async (toolName, toolInput, extra) => {
        const d = await o.gate.wait(toolName, toolInput, extra.signal, extra.toolUseID);
        return d.allow
          ? { behavior: 'allow', updatedInput: d.input ?? toolInput }
          : { behavior: 'deny', message: d.message };
      },
    };

    const q = query({ prompt: input(), options });

    async function* events(): AsyncIterable<EngineEvent> {
      let sawDelta = false;
      let gotResult = false;
      try {
        for await (const m of q) {
          if (m.type === 'system' && m.subtype === 'init') {
            yield { type: 'session', sessionId: m.session_id, account: String((m as any).apiKeySource ?? '') };
          } else if (m.type === 'stream_event') {
            if (m.parent_tool_use_id) continue;
            const ev = m.event as any;
            if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
              sawDelta = true;
              yield { type: 'text', add: ev.delta.text };
            }
          } else if (m.type === 'assistant') {
            if (m.parent_tool_use_id) continue;
            for (const block of (m.message.content ?? []) as any[]) {
              if (block.type === 'text' && block.text && !sawDelta) yield { type: 'text', add: block.text };
              else if (block.type === 'tool_use') yield { type: 'tool-start', id: block.id, name: block.name, input: block.input };
            }
            sawDelta = false;
          } else if (m.type === 'user') {
            if (m.parent_tool_use_id) continue;
            const content = (m.message as any).content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block?.type === 'tool_result') yield { type: 'tool-end', id: block.tool_use_id, ok: !block.is_error };
              }
            }
          } else if (m.type === 'result') {
            gotResult = true;
            // Ask how full the conversation is while it is still open. This is answered locally.
            const context = await Promise.race([readContext(q), sleep(4000).then(() => null)]).catch(() => null);
            if (context) yield { type: 'context', ...context };
            release();
            const r = m as any;
            const ok = r.subtype === 'success' && !r.is_error;
            const error = ok ? undefined : String(r.result ?? (Array.isArray(r.errors) ? r.errors.join('; ') : r.subtype ?? 'error'));
            yield {
              type: 'result', ok, error, costUsd: r.total_cost_usd, durationMs: r.duration_ms,
              inputTokens: r.usage?.input_tokens, outputTokens: r.usage?.output_tokens,
            };
          }
        }
      } catch (e) {
        release();
        if (!gotResult && !abort.signal.aborted) {
          const tail = stderrTail.join('').trim().split('\n').slice(-3).join(' ');
          yield { type: 'result', ok: false, error: `${(e as Error).message}${tail ? ` (${tail})` : ''}` };
        }
        return;
      }
      release();
      if (!gotResult && !abort.signal.aborted) yield { type: 'result', ok: false, error: 'Claude Code ended without finishing.' };
    }

    return {
      events: events(),
      interrupt: () => {
        q.interrupt().catch(() => undefined).finally(() => {
          release();
          setTimeout(() => abort.abort(), 1500).unref();
        });
      },
    };
  }

  async ask(o: { system: string; prompt: string; configDir: string | null }): Promise<string> {
    const q = query({
      prompt: o.prompt,
      options: {
        systemPrompt: o.system,
        maxTurns: 1,
        tools: [],
        allowedTools: [],
        settingSources: [],
        persistSession: false,
        env: childEnv(o.configDir, { officeConfigDir: this.officeConfigDir }),
        pathToClaudeCodeExecutable: this.claudePath ?? undefined,
        cwd: os.tmpdir(),
      },
    });
    let out = '';
    for await (const m of q) {
      if (m.type === 'result') {
        const r = m as any;
        if (r.subtype !== 'success' || r.is_error) throw new Error(String(r.result ?? r.subtype));
        out = String(r.result ?? '');
      }
    }
    return out.trim();
  }

  /** Start Claude Code, ask it who is signed in and which apps are connected, and stop. No message is sent. */
  async info(o: { configDir: string | null; cwd: string }): Promise<EngineInfo> {
    const abort = new AbortController();
    let release!: () => void;
    const finished = new Promise<void>((res) => { release = res; });
    async function* input(): AsyncIterable<SDKUserMessage> { await finished; }
    const out: EngineInfo = { engine: this.name, account: null, connectors: [], checkedAt: Date.now() };
    try {
      const q = query({
        prompt: input(),
        options: {
          cwd: o.cwd, settingSources: ['project'], persistSession: false, abortController: abort,
          env: childEnv(o.configDir, { connectors: true, officeConfigDir: this.officeConfigDir }), pathToClaudeCodeExecutable: this.claudePath ?? undefined,
        },
      });
      const account = await q.accountInfo();
      out.account = { email: account.email ?? null, plan: account.subscriptionType ?? null };
      try {
        out.models = (await q.supportedModels()).map((m: any) => ({
          value: String(m.value), name: String(m.displayName ?? m.value), description: String(m.description ?? ''), resolved: m.resolvedModel ? String(m.resolvedModel) : null,
          efforts: m.supportsEffort && Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.filter((e: unknown): e is Effort => EFFORTS.includes(e as Effort)) : [],
        }));
      } catch { /* an older Claude Code that cannot list them */ }
      // Connected apps arrive a moment after start; wait for them to settle, but not for long.
      let servers: Awaited<ReturnType<typeof q.mcpServerStatus>> = [];
      for (let i = 0; i < 16; i++) {
        servers = await q.mcpServerStatus();
        if (i >= 3 && servers.every((s) => s.status !== 'pending')) break;
        await sleep(500);
      }
      out.connectors = servers
        .filter((s) => s.name !== 'bureau')
        .map((s) => ({
          name: s.name.replace(/^claude\.ai\s+/i, ''),
          status: (['connected', 'needs-auth', 'failed', 'pending', 'disabled'] as const).find((x) => x === s.status) ?? 'failed',
          tools: s.tools?.length ?? 0,
        }));
    } catch (e) {
      out.error = (e as Error).message;
    } finally {
      release();
      abort.abort();
    }
    return out;
  }

  /**
   * Start Claude Code, ask it for the figures behind its own /usage screen, and stop. No message
   * is sent, so this spends nothing. The SDK marks the call experimental; if it goes away this
   * throws and the office carries on without the readout.
   */
  async usage(o: { configDir: string | null }): Promise<{ week: UsageWindow | null }> {
    const abort = new AbortController();
    let release!: () => void;
    const finished = new Promise<void>((res) => { release = res; });
    async function* input(): AsyncIterable<SDKUserMessage> { await finished; }
    try {
      const q = query({
        prompt: input(),
        options: {
          cwd: os.tmpdir(), settingSources: [], persistSession: false, abortController: abort,
          env: childEnv(o.configDir, { officeConfigDir: this.officeConfigDir }), pathToClaudeCodeExecutable: this.claudePath ?? undefined,
        },
      });
      const ask = (q as any).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
      if (typeof ask !== 'function') throw new Error('This version of Claude Code does not report plan usage.');
      const res = await ask.call(q, { skipBehaviors: true });
      if (!res?.rate_limits_available || !res.rate_limits) throw new Error('This Claude account has no plan limits to report.');
      const win = (w: { utilization: number | null; resets_at: string | null } | null | undefined): UsageWindow | null => {
        if (!w || typeof w.utilization !== 'number') return null;
        const at = w.resets_at ? Date.parse(w.resets_at) : NaN;
        return { used: Math.max(0, Math.min(100, w.utilization)), resetsAt: Number.isFinite(at) ? at : null };
      };
      return { week: win(res.rate_limits.seven_day) };
    } finally {
      release();
      abort.abort();
    }
  }

  /**
   * Open a saved conversation without writing to it, ask Claude Code how full it is, and stop. No
   * message is sent. The office's own tools are not loaded for this, so it reads a little low
   * until the next turn ends and reports the exact figure.
   */
  async context(o: { staffId: string; sessionId: string | null; cwd: string; model: string | null; configDir: string | null; compactWindow: number | null }): Promise<ContextReading | null> {
    if (!o.sessionId) return null;
    const abort = new AbortController();
    let release!: () => void;
    const finished = new Promise<void>((res) => { release = res; });
    async function* input(): AsyncIterable<SDKUserMessage> { await finished; }
    try {
      const q = query({
        prompt: input(),
        options: {
          cwd: o.cwd, settingSources: ['project'], persistSession: false, resume: o.sessionId, abortController: abort,
          model: o.model ?? undefined,
          ...(o.compactWindow ? { settings: { autoCompactWindow: o.compactWindow } } : {}),
          env: childEnv(o.configDir, { officeConfigDir: this.officeConfigDir }), pathToClaudeCodeExecutable: this.claudePath ?? undefined,
        },
      });
      return await Promise.race([readContext(q), sleep(15_000).then(() => null)]);
    } finally {
      release();
      abort.abort();
    }
  }
}

/** Claude Code's own measure of the open conversation: tokens in use, the window, and where compaction starts. */
async function readContext(q: { getContextUsage?: (o?: { detail?: 'summary' | 'full' }) => Promise<any> }): Promise<ContextReading | null> {
  if (typeof q.getContextUsage !== 'function') return null;
  const r = await q.getContextUsage({ detail: 'summary' });
  const used = Number(r?.totalTokens);
  const window = Number(r?.rawMaxTokens ?? r?.maxTokens);
  if (!Number.isFinite(used) || !Number.isFinite(window) || window <= 0) return null;
  const at = Number(r?.autoCompactThreshold);
  return { used, window, compactsAt: r?.isAutoCompactEnabled !== false && Number.isFinite(at) && at > 0 ? Math.min(at, window) : window };
}
