import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { scanProject } from '../src/scanner.js';
import { analyzeProdTruth } from '../src/prod-truth.js';
import { createAppsScriptMetricsProvider } from '../src/providers/apps-script-metrics.js';
import { buildScriptIdMap, resolveScriptIdFromClasp } from '../src/script-id.js';

interface MockRequest {
  pathname: string;
  authHeader: string | null;
  scriptId: string | null;
  startTime: string | null;
  pageToken: string | null;
}

interface RawProcess {
  functionName: string;
  processStatus: string;
  startTime: string;
}

interface MockHandler {
  (req: MockRequest, pageIndex: number): {
    status: number;
    body: { processes?: RawProcess[]; nextPageToken?: string };
  };
}

interface MockServer {
  url: string;
  requests: MockRequest[];
  close: () => Promise<void>;
}

async function startMockServer(handler: MockHandler): Promise<MockServer> {
  const requests: MockRequest[] = [];
  let pageIndex = 0;
  const server: Server = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const mreq: MockRequest = {
        pathname: url.pathname,
        authHeader: (req.headers['authorization'] as string | undefined) ?? null,
        scriptId: url.searchParams.get('scriptId'),
        startTime: url.searchParams.get('scriptProcessFilter.startTime'),
        pageToken: url.searchParams.get('pageToken'),
      };
      requests.push(mreq);
      const out = handler(mreq, pageIndex);
      pageIndex += 1;
      res.statusCode = out.status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(out.body));
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('listen failed');
  const url = `http://127.0.0.1:${addr.port}/v1`;
  return {
    url,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

describe('createAppsScriptMetricsProvider — agrégation', () => {
  let mock: MockServer;
  beforeEach(async () => {
    mock = await startMockServer((_req) => ({
      status: 200,
      body: {
        processes: [
          { functionName: 'doGet', processStatus: 'COMPLETED', startTime: '2026-06-15T10:00:00Z' },
          { functionName: 'doGet', processStatus: 'COMPLETED', startTime: '2026-06-16T10:00:00Z' },
          { functionName: 'doGet', processStatus: 'FAILED', startTime: '2026-06-17T10:00:00Z' },
          { functionName: 'runJob', processStatus: 'COMPLETED', startTime: '2026-06-17T11:00:00Z' },
          { functionName: 'runJob', processStatus: 'TIMED_OUT', startTime: '2026-06-17T12:00:00Z' },
        ],
      },
    }));
  });
  afterEach(async () => {
    await mock.close();
  });

  it('agrège count + errors + last_execution_at par fonction', async () => {
    const provider = await createAppsScriptMetricsProvider({
      baseUrl: mock.url,
      getAccessToken: async () => 'tok',
    });
    const metrics = await provider.getMetrics({
      scriptId: 'sid-x',
      project: 'App',
      function_names: ['doGet', 'runJob'],
      window_days: 30,
    });
    expect(metrics).toHaveLength(2);
    const doGet = metrics.find((m) => m.function_name === 'doGet')!;
    expect(doGet.executions_count).toBe(3);
    expect(doGet.error_count).toBe(1);
    expect(doGet.error_rate).toBeCloseTo(1 / 3, 5);
    expect(doGet.last_execution_at).toBe('2026-06-17T10:00:00Z');
    expect(doGet.window_days).toBe(30);
    const runJob = metrics.find((m) => m.function_name === 'runJob')!;
    expect(runJob.executions_count).toBe(2);
    expect(runJob.error_count).toBe(1);
    expect(runJob.last_execution_at).toBe('2026-06-17T12:00:00Z');
  });

  it("inclut les fonctions demandées sans process (executions_count: 0)", async () => {
    const provider = await createAppsScriptMetricsProvider({
      baseUrl: mock.url,
      getAccessToken: async () => 'tok',
    });
    const metrics = await provider.getMetrics({
      scriptId: 'sid-x',
      project: 'App',
      function_names: ['doGet', 'neverCalled_'],
      window_days: 30,
    });
    const ghost = metrics.find((m) => m.function_name === 'neverCalled_')!;
    expect(ghost.executions_count).toBe(0);
    expect(ghost.error_rate).toBeNull();
    expect(ghost.last_execution_at).toBeNull();
  });

  it("scriptId: null → retourne [] sans appel API", async () => {
    const provider = await createAppsScriptMetricsProvider({
      baseUrl: mock.url,
      getAccessToken: async () => 'tok',
    });
    const metrics = await provider.getMetrics({
      scriptId: null,
      project: 'App',
      function_names: ['x'],
      window_days: 30,
    });
    expect(metrics).toEqual([]);
    expect(mock.requests).toHaveLength(0);
  });

  it("cache mémoire keyé par scriptId#window_days (2 appels = 1 hit serveur)", async () => {
    const provider = await createAppsScriptMetricsProvider({
      baseUrl: mock.url,
      getAccessToken: async () => 'tok',
    });
    await provider.getMetrics({
      scriptId: 'sid-x',
      project: 'App',
      function_names: ['doGet'],
      window_days: 30,
    });
    await provider.getMetrics({
      scriptId: 'sid-x',
      project: 'App',
      function_names: ['doGet'],
      window_days: 30,
    });
    expect(mock.requests).toHaveLength(1);
  });

  it("disableCache: true → un appel API par getMetrics", async () => {
    const provider = await createAppsScriptMetricsProvider({
      baseUrl: mock.url,
      getAccessToken: async () => 'tok',
      disableCache: true,
    });
    await provider.getMetrics({ scriptId: 'sid-x', project: 'App', function_names: ['doGet'], window_days: 30 });
    await provider.getMetrics({ scriptId: 'sid-x', project: 'App', function_names: ['doGet'], window_days: 30 });
    expect(mock.requests).toHaveLength(2);
  });

  it('passe scriptId + startTime dans la query string', async () => {
    const provider = await createAppsScriptMetricsProvider({
      baseUrl: mock.url,
      getAccessToken: async () => 'tok',
    });
    await provider.getMetrics({
      scriptId: 'sid-x',
      project: 'App',
      function_names: [],
      window_days: 7,
    });
    const req = mock.requests[0]!;
    expect(req.scriptId).toBe('sid-x');
    expect(req.startTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(req.authHeader).toBe('Bearer tok');
    expect(req.pathname).toBe('/v1/processes:listScriptProcesses');
  });
});

describe('createAppsScriptMetricsProvider — pagination', () => {
  it('parcourt les pages tant que nextPageToken est présent', async () => {
    const mock = await startMockServer((_req, page) => {
      if (page === 0) {
        return {
          status: 200,
          body: {
            processes: [
              { functionName: 'doGet', processStatus: 'COMPLETED', startTime: '2026-06-15T10:00:00Z' },
            ],
            nextPageToken: 'tok-page-2',
          },
        };
      }
      if (page === 1) {
        return {
          status: 200,
          body: {
            processes: [
              { functionName: 'doGet', processStatus: 'COMPLETED', startTime: '2026-06-16T10:00:00Z' },
            ],
          },
        };
      }
      return { status: 200, body: { processes: [] } };
    });
    try {
      const provider = await createAppsScriptMetricsProvider({
        baseUrl: mock.url,
        getAccessToken: async () => 'tok',
      });
      const metrics = await provider.getMetrics({
        scriptId: 'sid',
        project: 'p',
        function_names: ['doGet'],
        window_days: 30,
      });
      expect(metrics[0]?.executions_count).toBe(2);
      expect(mock.requests).toHaveLength(2);
      expect(mock.requests[1]?.pageToken).toBe('tok-page-2');
    } finally {
      await mock.close();
    }
  });

  it('respecte max_pages et signale truncated quand on coupe avant la fin', async () => {
    const mock = await startMockServer((_req) => ({
      status: 200,
      body: {
        processes: [
          { functionName: 'doGet', processStatus: 'COMPLETED', startTime: '2026-06-15T10:00:00Z' },
        ],
        nextPageToken: 'always-more',
      },
    }));
    try {
      const provider = await createAppsScriptMetricsProvider({
        baseUrl: mock.url,
        getAccessToken: async () => 'tok',
        max_pages: 3,
      });
      const metrics = await provider.getMetrics({
        scriptId: 'sid',
        project: 'p',
        function_names: ['doGet'],
        window_days: 30,
      });
      expect(mock.requests).toHaveLength(3);
      expect(metrics[0]?.executions_count).toBe(3);
      expect(metrics[0]?.truncated).toBe(true);
    } finally {
      await mock.close();
    }
  });
});

describe('createAppsScriptMetricsProvider — gestion des erreurs', () => {
  it('403 → renvoie un agrégat partiel (frontière honnête, ne throw pas)', async () => {
    const mock = await startMockServer(() => ({ status: 403, body: {} }));
    try {
      const provider = await createAppsScriptMetricsProvider({
        baseUrl: mock.url,
        getAccessToken: async () => 'tok',
      });
      const m = await provider.getMetrics({
        scriptId: 'sid',
        project: 'p',
        function_names: ['x'],
        window_days: 30,
      });
      // L'agrégat est vide → la fonction est remplie avec executions_count: 0.
      expect(m[0]?.executions_count).toBe(0);
    } finally {
      await mock.close();
    }
  });

  it('500 → throw (rattrapé en amont par safeGetMetrics → unknown)', async () => {
    const mock = await startMockServer(() => ({
      status: 500,
      body: { error: 'internal' },
    }));
    try {
      const provider = await createAppsScriptMetricsProvider({
        baseUrl: mock.url,
        getAccessToken: async () => 'tok',
      });
      await expect(
        provider.getMetrics({
          scriptId: 'sid',
          project: 'p',
          function_names: ['x'],
          window_days: 30,
        }),
      ).rejects.toThrow(/HTTP 500/);
    } finally {
      await mock.close();
    }
  });
});

describe('resolveScriptIdFromClasp', () => {
  it('lit .clasp.json à la racine du projet', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gaslens-clasp-'));
    try {
      await writeFile(
        join(root, '.clasp.json'),
        JSON.stringify({ scriptId: 'sid-from-clasp', rootDir: './src' }),
        'utf8',
      );
      const sid = await resolveScriptIdFromClasp(root);
      expect(sid).toBe('sid-from-clasp');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renvoie null si .clasp.json absent", async () => {
    const root = await mkdtemp(join(tmpdir(), 'gaslens-clasp-'));
    try {
      expect(await resolveScriptIdFromClasp(root)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renvoie null si .clasp.json sans champ scriptId ou JSON invalide", async () => {
    const root = await mkdtemp(join(tmpdir(), 'gaslens-clasp-'));
    try {
      await writeFile(join(root, '.clasp.json'), '{not json', 'utf8');
      expect(await resolveScriptIdFromClasp(root)).toBeNull();
      await writeFile(join(root, '.clasp.json'), '{}', 'utf8');
      expect(await resolveScriptIdFromClasp(root)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('buildScriptIdMap — overrides + .clasp.json', () => {
  it('overrides explicites priment sur .clasp.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gaslens-sidmap-'));
    try {
      await writeFile(
        join(root, 'appsscript.json'),
        '{}',
        'utf8',
      );
      await writeFile(
        join(root, '.clasp.json'),
        JSON.stringify({ scriptId: 'sid-clasp' }),
        'utf8',
      );
      await writeFile(join(root, 'main.gs'), 'function f(){}', 'utf8');
      const idx = await scanProject({ root });
      // Sans override → .clasp.json.
      const m1 = await buildScriptIdMap(idx);
      expect(m1.get(idx.project)).toBe('sid-clasp');
      // Avec override → override.
      const m2 = await buildScriptIdMap(idx, { [idx.project]: 'sid-override' });
      expect(m2.get(idx.project)).toBe('sid-override');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('intégration analyzeProdTruth + AppsScriptMetricsProvider', () => {
  it("annonte les fonctions avec live/confirmed_dead/errored selon les processes", async () => {
    const mock = await startMockServer(() => ({
      status: 200,
      body: {
        processes: [
          // doGet : nombreuses exécutions, sans erreur → live
          ...Array.from({ length: 60 }, () => ({
            functionName: 'doGet',
            processStatus: 'COMPLETED',
            startTime: '2026-06-15T10:00:00Z',
          })),
          // brokenFn : 5 exécutions dont 4 erreurs → errored
          ...Array.from({ length: 5 }, (_, i) => ({
            functionName: 'brokenFn',
            processStatus: i < 4 ? 'FAILED' : 'COMPLETED',
            startTime: '2026-06-16T10:00:00Z',
          })),
        ],
      },
    }));
    const root = await mkdtemp(join(tmpdir(), 'gaslens-prod-int-'));
    try {
      await writeFile(join(root, 'appsscript.json'), '{}', 'utf8');
      await writeFile(
        join(root, 'main.gs'),
        // doGet : exposition entry_point_web. brokenFn : appelée par doGet.
        // deadFn_ : privée, aucune exposition, aucune exécution → confirmed_dead.
        `function doGet(){ brokenFn(); }
function brokenFn(){ return 1; }
function deadFn_(){ return 2; }`,
        'utf8',
      );
      const idx = await scanProject({ root });
      const provider = await createAppsScriptMetricsProvider({
        baseUrl: mock.url,
        getAccessToken: async () => 'tok',
      });
      const report = await analyzeProdTruth(idx, provider, {
        window_days: 30,
        script_id_by_project: new Map([[idx.project, 'sid-app']]),
      });
      const doGet = report.entries.find((e) => e.function_name === 'doGet')!;
      const broken = report.entries.find((e) => e.function_name === 'brokenFn')!;
      const dead = report.entries.find((e) => e.function_name === 'deadFn_')!;
      expect(doGet.cross_status).toBe('live');
      expect(broken.cross_status).toBe('errored');
      expect(dead.cross_status).toBe('confirmed_dead');
    } finally {
      await rm(root, { recursive: true, force: true });
      await mock.close();
    }
  });
});
