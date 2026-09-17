import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine, type EngineOptions } from '../src/core/engine.ts';

export function tempDir(prefix = 'ct-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

export async function withEngine<T>(fn: (e: Engine, dir: string) => Promise<T> | T, opts: Partial<EngineOptions> = {}): Promise<T> {
  const { dir, cleanup } = tempDir();
  const home = mkdtempSync(join(tmpdir(), 'ct-home-'));
  const engine = new Engine({ dataDir: dir, collectors: false, home, ...opts });
  try {
    return await fn(engine, dir);
  } finally {
    await engine.stop();
    cleanup();
    rmSync(home, { recursive: true, force: true });
  }
}

export const claudePre = (session: string, tool: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  session_id: session, cwd: '/work/repo', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: `tu_${Math.random().toString(36).slice(2)}`, ...extra,
});
