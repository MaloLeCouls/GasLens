import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createGaslensMcpServer } from '../src/mcp-server.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..');
const MCP_BIN = resolve(REPO_ROOT, 'bin/gaslens-mcp.js');
const FIXTURE = resolve(REPO_ROOT, 'tests/fixtures/sample-project');

describe('MCP server — création (unit)', () => {
  it('createGaslensMcpServer renvoie un McpServer instancié', () => {
    const server = createGaslensMcpServer();
    expect(server).toBeDefined();
    expect(typeof (server as { server: object }).server).toBe('object');
  });
});

// Test d'intégration : spawn du process, dialogue JSON-RPC sur stdio.
// On garde 3 cas (initialize / tools/list / tools/call gaslens_map) — c'est
// suffisant pour vérifier que le wrapper est connecté à la logique gaslens.
describe('MCP server — JSON-RPC over stdio', () => {
  it('initialize + tools/list + tools/call gaslens_map', async () => {
    const child = spawn('node', [MCP_BIN], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: REPO_ROOT,
    });

    // Helper : écrit une requête JSON-RPC framée par newline, retourne la
    // réponse correspondante (matching par id).
    let buffer = '';
    const pending = new Map<number | string, (msg: unknown) => void>();
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as { id?: number | string };
          if (msg.id !== undefined) {
            const cb = pending.get(msg.id);
            if (cb) {
              pending.delete(msg.id);
              cb(msg);
            }
          }
        } catch {
          // ligne non-JSON (log, etc.) — ignorée
        }
      }
    });

    const sendRequest = <T = unknown>(
      method: string,
      params: unknown,
      id: number,
    ): Promise<T> =>
      new Promise<T>((res, rej) => {
        pending.set(id, (msg) => res(msg as T));
        const req = JSON.stringify({ jsonrpc: '2.0', id, method, params });
        child.stdin.write(req + '\n');
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            rej(new Error(`MCP request '${method}' (id=${id}) timed out`));
          }
        }, 10_000);
      });

    try {
      // 1. initialize
      const initRes = await sendRequest<{ result?: { serverInfo?: { name?: string } } }>(
        'initialize',
        {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'vitest', version: '0.0.0' },
        },
        1,
      );
      expect(initRes.result?.serverInfo?.name).toBe('gaslens');

      // Notification 'initialized' (sans id, sans réponse).
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        }) + '\n',
      );

      // 2. tools/list — on attend nos 4 outils.
      const listRes = await sendRequest<{
        result?: { tools?: Array<{ name: string }> };
      }>('tools/list', {}, 2);
      const names = (listRes.result?.tools ?? []).map((t) => t.name).sort();
      expect(names).toEqual([
        'gaslens_check',
        'gaslens_impact',
        'gaslens_inspect',
        'gaslens_map',
      ]);

      // 3. tools/call gaslens_map sur la fixture.
      const callRes = await sendRequest<{
        result?: {
          content?: Array<{ type: string; text?: string }>;
          isError?: boolean;
        };
      }>(
        'tools/call',
        {
          name: 'gaslens_map',
          arguments: { project_root: FIXTURE },
        },
        3,
      );
      expect(callRes.result?.isError).not.toBe(true);
      const text = callRes.result?.content?.[0]?.text;
      expect(text).toBeDefined();
      const payload = JSON.parse(text!);
      expect(payload.kind).toMatch(/^(project_map|workspace_map)$/);
      expect(Array.isArray(payload.projects)).toBe(true);
      expect(payload.projects.length).toBeGreaterThan(0);
    } finally {
      child.kill();
    }
  }, 30_000);
});
