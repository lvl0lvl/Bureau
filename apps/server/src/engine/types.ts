import type { ZodType } from 'zod';
import type { ContextUse, Effort, EngineInfo, UsageWindow } from '../../../../shared/contract.ts';

/** How full a conversation is, as the engine reports it. */
export type ContextReading = Omit<ContextUse, 'at'>;

/** A tool the office itself offers to staff (logging finished work, asking the owner, and so on). */
export interface AppTool {
  name: string;
  description: string;
  shape: Record<string, ZodType>;
  run(args: any): Promise<string>;
}

export type GateWait =
  | { allow: true; input?: Record<string, unknown> }
  | { allow: false; message: string };

/** The authority gate as an engine sees it. `check` is instant; `wait` may block on a signature. */
export interface Gate {
  check(tool: string, input: unknown, toolUseId?: string): { outcome: 'allow' | 'ask' } | { outcome: 'deny'; message: string };
  wait(tool: string, input: Record<string, unknown>, signal: AbortSignal, toolUseId?: string): Promise<GateWait>;
}

export type EngineEvent =
  | { type: 'session'; sessionId: string; account?: string }
  | { type: 'text'; add: string }
  | { type: 'tool-start'; id: string; name: string; input: unknown }
  | { type: 'tool-end'; id: string; ok: boolean }
  /** How full the conversation is now. Sent once, as the turn ends. */
  | ({ type: 'context' } & ContextReading)
  | { type: 'result'; ok: boolean; error?: string; costUsd?: number; durationMs?: number; inputTokens?: number; outputTokens?: number };

export interface RunOptions {
  staffId: string;
  prompt: string;
  /** Resume this conversation; null starts a new one. */
  sessionId: string | null;
  /** Appended to the engine's own system prompt. Must not change between turns unless something real changed. */
  systemAppend: string;
  cwd: string;
  extraDirs: string[];
  model: string | null;
  /** Null leaves the model's own default. */
  effort?: Effort | null;
  configDir: string | null;
  /** The window, in tokens, the conversation is compacted to stay within. Null leaves the engine's own. */
  compactWindow?: number | null;
  tools: AppTool[];
  gate: Gate;
}

export interface EngineTurn {
  events: AsyncIterable<EngineEvent>;
  interrupt(): void;
}

export interface Engine {
  readonly name: string;
  run(options: RunOptions): EngineTurn;
  /** One short answer with no tools and no memory. Used for the chief of staff's check of a slip. */
  ask(options: { system: string; prompt: string; configDir: string | null }): Promise<string>;
  /** Which account and connected apps staff have. Must not spend any usage. */
  info(options: { configDir: string | null; cwd: string }): Promise<EngineInfo>;
  /** How much of the plan's limits is used. Must not spend any usage. Absent when the engine cannot say. */
  usage?(options: { configDir: string | null }): Promise<{ week: UsageWindow | null }>;
  /**
   * How full a saved conversation is, without running a turn. Must not spend any usage or write to
   * the conversation. Null when there is nothing to measure.
   */
  context?(options: { staffId: string; sessionId: string | null; cwd: string; model: string | null; configDir: string | null; compactWindow: number | null }): Promise<ContextReading | null>;
}
