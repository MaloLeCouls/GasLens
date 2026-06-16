import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { scanProject } from '../src/scanner.js';
import { analyzeLiveLibraries } from '../src/resolve-live.js';
import {
  createAppsScriptApiFetcher,
  mapResponseToLibrarySource,
} from '../src/fetchers/apps-script-api.js';

interface MockRequest {
  pathname: string;
  authHeader: string | null;
  versionNumber: string | null;
}

interface MockHandler {
  (req: MockRequest): { status: number; body: unknown };
}

interface MockServer {
  url: string;
  requests: MockRequest[];
  close: () => Promise<void>;
}

async function startMockServer(handler: MockHandler): Promise<MockServer> {
  const requests: MockRequest[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const mreq: MockRequest = {
      pathname: url.pathname,
      authHeader: (req.headers['authorization'] as string | undefined) ?? null,
      versionNumber: url.searchParams.get('versionNumber'),
    };
    requests.push(mreq);
    const out = handler(mreq);
    res.statusCode = out.status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(out.body));
  });
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

describe('mapResponseToLibrarySource', () => {
  it('mappe les types Google vers la forme canonique', () => {
    const src = mapResponseToLibrarySource({
      scriptId: 'sid',
      files: [
        { name: 'Main', source: 'function f(){}', type: 'SERVER_JS' },
        { name: 'index', source: '<html></html>', type: 'HTML' },
        { name: 'appsscript', source: '{}', type: 'JSON' },
        { name: 'weird', source: 'x', type: 'UNKNOWN_FUTURE' },
      ],
    });
    expect(src.files).toHaveLength(4);
    expect(src.files[0]?.type).toBe('SERVER_JS');
    expect(src.files[1]?.type).toBe('HTML');
    expect(src.files[2]?.type).toBe('JSON');
    expect(src.files[3]?.type).toBe('SERVER_JS'); // default
    expect(src.meta?.scriptId).toBe('sid');
  });

  it('ignore les entrées invalides (champ manquant)', () => {
    const src = mapResponseToLibrarySource({
      files: [
        { name: 'ok', source: 'x', type: 'SERVER_JS' },
        { name: 'broken' }, // pas de source
        { source: 'orphan' }, // pas de nom
      ],
    });
    expect(src.files).toHaveLength(1);
    expect(src.files[0]?.name).toBe('ok');
  });
});

describe('createAppsScriptApiFetcher — fetch successful', () => {
  let mock: MockServer;
  beforeEach(async () => {
    mock = await startMockServer((req) => {
      if (req.pathname.endsWith('/content')) {
        return {
          status: 200,
          body: {
            scriptId: 'sid-fake',
            files: [
              { name: 'Lib', source: 'function api(){}', type: 'SERVER_JS' },
            ],
          },
        };
      }
      return { status: 404, body: { error: 'not_found' } };
    });
  });
  afterEach(async () => {
    await mock.close();
  });

  it('appelle projects.getContent et mappe la réponse', async () => {
    const fetcher = await createAppsScriptApiFetcher({
      baseUrl: mock.url,
      getAccessToken: async () => 'fake-token',
    });
    const result = await fetcher.fetch('sid-fake', null);
    expect(result).not.toBeNull();
    expect(result?.files).toHaveLength(1);
    expect(result?.files[0]?.name).toBe('Lib');
    expect(mock.requests[0]?.pathname).toBe('/v1/projects/sid-fake/content');
    expect(mock.requests[0]?.authHeader).toBe('Bearer fake-token');
  });

  it('passe versionNumber en query string quand version est numérique', async () => {
    const fetcher = await createAppsScriptApiFetcher({
      baseUrl: mock.url,
      getAccessToken: async () => 'fake-token',
    });
    await fetcher.fetch('sid-fake', '42');
    expect(mock.requests[0]?.versionNumber).toBe('42');
  });

  it("n'ajoute pas versionNumber pour une version non numérique (ex: 'HEAD')", async () => {
    const fetcher = await createAppsScriptApiFetcher({
      baseUrl: mock.url,
      getAccessToken: async () => 'fake-token',
    });
    await fetcher.fetch('sid-fake', 'HEAD');
    expect(mock.requests[0]?.versionNumber).toBeNull();
  });

  it('met en cache mémoire (2e fetch identique = 0 hit serveur)', async () => {
    const fetcher = await createAppsScriptApiFetcher({
      baseUrl: mock.url,
      getAccessToken: async () => 'fake-token',
    });
    await fetcher.fetch('sid-fake', null);
    await fetcher.fetch('sid-fake', null);
    expect(mock.requests).toHaveLength(1);
  });

  it('disableCache: true → un fetch par appel', async () => {
    const fetcher = await createAppsScriptApiFetcher({
      baseUrl: mock.url,
      disableCache: true,
      getAccessToken: async () => 'fake-token',
    });
    await fetcher.fetch('sid-fake', null);
    await fetcher.fetch('sid-fake', null);
    expect(mock.requests).toHaveLength(2);
  });
});

describe('createAppsScriptApiFetcher — gestion des erreurs', () => {
  it('403 → null (frontière honnête : container-bound ou scope manquant)', async () => {
    const server = await startMockServer(() => ({ status: 403, body: {} }));
    try {
      const fetcher = await createAppsScriptApiFetcher({
        baseUrl: server.url,
        getAccessToken: async () => 't',
      });
      const result = await fetcher.fetch('sid', null);
      expect(result).toBeNull();
    } finally {
      await server.close();
    }
  });

  it('404 → null (script inexistant ou pas de droits)', async () => {
    const server = await startMockServer(() => ({ status: 404, body: {} }));
    try {
      const fetcher = await createAppsScriptApiFetcher({
        baseUrl: server.url,
        getAccessToken: async () => 't',
      });
      const result = await fetcher.fetch('sid', null);
      expect(result).toBeNull();
    } finally {
      await server.close();
    }
  });

  it('500 → throw (erreur réelle, propagée en external_unresolvable)', async () => {
    const server = await startMockServer(() => ({
      status: 500,
      body: { error: 'internal' },
    }));
    try {
      const fetcher = await createAppsScriptApiFetcher({
        baseUrl: server.url,
        getAccessToken: async () => 't',
      });
      await expect(fetcher.fetch('sid', null)).rejects.toThrow(/HTTP 500/);
    } finally {
      await server.close();
    }
  });
});

describe('intégration analyzeLiveLibraries + AppsScriptApiFetcher', () => {
  it("fait passer une lib externe d'unfetched à external_resolved", async () => {
    const server = await startMockServer((req) => ({
      status: 200,
      body: {
        scriptId: req.pathname.split('/')[3],
        files: [{ name: 'OAuth2', source: 'function f(){}', type: 'SERVER_JS' }],
      },
    }));
    const root = await mkdtemp(join(tmpdir(), 'gaslens-ph2-'));
    try {
      await writeFile(
        join(root, 'appsscript.json'),
        JSON.stringify({
          dependencies: {
            libraries: [
              { userSymbol: 'OAuth2', libraryId: 'sid-oauth2', version: '43' },
            ],
          },
        }),
        'utf8',
      );
      await mkdir(join(root), { recursive: true });
      await writeFile(
        join(root, 'main.gs'),
        `function go() { return OAuth2.createService('x'); }`,
        'utf8',
      );
      const idx = await scanProject({ root });
      const fetcher = await createAppsScriptApiFetcher({
        baseUrl: server.url,
        getAccessToken: async () => 'tok',
      });
      const report = await analyzeLiveLibraries(idx, fetcher);
      expect(report.summary.external_resolved).toBe(1);
      expect(report.summary.external_unfetched).toBe(0);
      const lib = report.libraries[0]!;
      expect(lib.status).toBe('external_resolved');
    } finally {
      await rm(root, { recursive: true, force: true });
      await server.close();
    }
  });
});
