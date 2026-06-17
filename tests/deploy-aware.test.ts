import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { scanProject } from '../src/scanner.js';
import {
  analyzeDeployments,
  NoopDeploymentsProvider,
  renderDeployAwareText,
  type DeploymentsProvider,
  type Deployment,
  type VersionInfo,
} from '../src/deploy-aware.js';
import { createAppsScriptDeploymentsProvider } from '../src/providers/apps-script-deployments.js';

interface MockHandler {
  (req: { pathname: string }, pageIndex: number): {
    status: number;
    body: unknown;
  };
}

interface MockServer {
  url: string;
  requests: string[];
  close: () => Promise<void>;
}

async function startMockServer(handler: MockHandler): Promise<MockServer> {
  const requests: string[] = [];
  let pageIndex = 0;
  const server: Server = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      requests.push(url.pathname);
      const out = handler({ pathname: url.pathname }, pageIndex);
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

async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gaslens-da-'));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(root, name), content, 'utf8');
  }
  return root;
}

const webAppDeployment: Deployment = {
  deployment_id: 'AKfycbz-LIVE',
  version_number: 3,
  description: 'web app live',
  update_time: '2026-06-01T00:00:00Z',
  entry_points: [
    {
      type: 'WEB_APP',
      url: 'https://script.google.com/macros/s/AKfycbz-LIVE/exec',
      execute_as: 'USER_DEPLOYING',
      access: 'ANYONE',
      addon_type: null,
    },
  ],
};

const addonDeployment: Deployment = {
  deployment_id: 'AKfycbz-ADDON',
  version_number: 2,
  description: 'add-on',
  update_time: '2026-05-01T00:00:00Z',
  entry_points: [
    {
      type: 'ADD_ON',
      url: null,
      execute_as: null,
      access: null,
      addon_type: 'EDITOR_AUDIT',
    },
  ],
};

const apiDeployment: Deployment = {
  deployment_id: 'AKfycbz-API',
  version_number: 1,
  description: 'execution api',
  update_time: '2026-04-01T00:00:00Z',
  entry_points: [
    {
      type: 'EXECUTION_API',
      url: null,
      execute_as: null,
      access: 'MYSELF',
      addon_type: null,
    },
  ],
};

function stubProvider(
  deployments: Deployment[],
  versions: VersionInfo[] = [],
): DeploymentsProvider {
  return {
    async listDeployments() {
      return deployments;
    },
    async listVersions() {
      return versions;
    },
  };
}

describe('analyzeDeployments — provider noop', () => {
  it("renvoie tout en `unknown` quand aucun provider n'est branché", async () => {
    const root = await makeProject({
      'appsscript.json': '{}',
      'main.gs': 'function doGet(){} function runJob(){}',
    });
    try {
      const idx = await scanProject({ root });
      const report = await analyzeDeployments(idx);
      expect(report.scope).toBe('project');
      expect(report.summary.total_projects).toBe(1);
      expect(report.summary.projects_unknown).toBe(1);
      expect(report.function_annotations.every((a) => a.deployment_status === 'unknown')).toBe(true);
      expect(report.advice.some((a) => a.includes('DeploymentsProvider'))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("NoopDeploymentsProvider renvoie [] pour deployments + versions", async () => {
    expect(await NoopDeploymentsProvider.listDeployments('sid')).toEqual([]);
    expect(await NoopDeploymentsProvider.listVersions('sid')).toEqual([]);
  });
});

describe('analyzeDeployments — classification web_app / addon / api', () => {
  it("doGet d'un projet avec déploiement web app live → `live_web_app`", async () => {
    const root = await makeProject({
      'appsscript.json': '{}',
      'main.gs': 'function doGet(){ return ContentService.createTextOutput("ok"); }\nfunction helper(){}',
    });
    try {
      const idx = await scanProject({ root });
      const provider = stubProvider([webAppDeployment]);
      const report = await analyzeDeployments(idx, provider, {
        script_id_by_project: new Map([[idx.project, 'sid-app']]),
      });
      const doGet = report.function_annotations.find((a) => a.function_name === 'doGet')!;
      const helper = report.function_annotations.find((a) => a.function_name === 'helper')!;
      expect(doGet.deployment_status).toBe('live_web_app');
      expect(doGet.served_by_deployments).toContain('AKfycbz-LIVE');
      expect(doGet.static_entry_point).toBe('doGet');
      // helper n'est pas un entry point connu → head_only.
      expect(helper.deployment_status).toBe('head_only');
      expect(report.summary.functions_live_web_app).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("onOpen d'un projet avec déploiement add-on → `live_addon`", async () => {
    const root = await makeProject({
      'appsscript.json': '{}',
      'main.gs': 'function onOpen(){} function utility(){}',
    });
    try {
      const idx = await scanProject({ root });
      const provider = stubProvider([addonDeployment]);
      const report = await analyzeDeployments(idx, provider, {
        script_id_by_project: new Map([[idx.project, 'sid-app']]),
      });
      const onOpen = report.function_annotations.find((a) => a.function_name === 'onOpen')!;
      expect(onOpen.deployment_status).toBe('live_addon');
      expect(report.summary.functions_live_addon).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fonctions publiques d'un projet avec Execution API → `live_api`", async () => {
    const root = await makeProject({
      'appsscript.json': '{}',
      'main.gs': 'function publicFn(){} function privateHelper_(){}',
    });
    try {
      const idx = await scanProject({ root });
      const provider = stubProvider([apiDeployment]);
      const report = await analyzeDeployments(idx, provider, {
        script_id_by_project: new Map([[idx.project, 'sid-app']]),
      });
      const pub = report.function_annotations.find((a) => a.function_name === 'publicFn')!;
      const priv = report.function_annotations.find((a) => a.function_name === 'privateHelper_')!;
      expect(pub.deployment_status).toBe('live_api');
      // Privée (suffix _) → pas couverte par l'API → head_only.
      expect(priv.deployment_status).toBe('head_only');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("priorité web_app > addon > api quand plusieurs s'appliquent", async () => {
    const root = await makeProject({
      'appsscript.json': '{}',
      'main.gs': 'function doGet(){} function onOpen(){} function publicFn(){}',
    });
    try {
      const idx = await scanProject({ root });
      const provider = stubProvider([webAppDeployment, addonDeployment, apiDeployment]);
      const report = await analyzeDeployments(idx, provider, {
        script_id_by_project: new Map([[idx.project, 'sid-app']]),
      });
      const doGet = report.function_annotations.find((a) => a.function_name === 'doGet')!;
      const onOpen = report.function_annotations.find((a) => a.function_name === 'onOpen')!;
      const pub = report.function_annotations.find((a) => a.function_name === 'publicFn')!;
      expect(doGet.deployment_status).toBe('live_web_app');
      expect(onOpen.deployment_status).toBe('live_addon');
      expect(pub.deployment_status).toBe('live_api');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('détecte version drift (déploiement live sur version antérieure à latest)', async () => {
    const root = await makeProject({
      'appsscript.json': '{}',
      'main.gs': 'function doGet(){}',
    });
    try {
      const idx = await scanProject({ root });
      const provider = stubProvider(
        [{ ...webAppDeployment, version_number: 2 }],
        [
          { version_number: 1, description: 'v1', create_time: '2026-01-01T00:00:00Z' },
          { version_number: 2, description: 'v2', create_time: '2026-02-01T00:00:00Z' },
          { version_number: 5, description: 'v5', create_time: '2026-05-01T00:00:00Z' },
        ],
      );
      const report = await analyzeDeployments(idx, provider, {
        script_id_by_project: new Map([[idx.project, 'sid-app']]),
      });
      const p = report.projects[0]!;
      expect(p.latest_version_number).toBe(5);
      expect(p.version_drift).toHaveLength(1);
      expect(p.version_drift[0]?.served_version).toBe(2);
      expect(p.version_drift[0]?.latest_version).toBe(5);
      expect(report.advice.some((a) => a.includes('version drift'))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('propage fetch_error quand le provider throw', async () => {
    const root = await makeProject({
      'appsscript.json': '{}',
      'main.gs': 'function doGet(){}',
    });
    try {
      const idx = await scanProject({ root });
      const failing: DeploymentsProvider = {
        async listDeployments() {
          throw new Error('HTTP 403');
        },
        async listVersions() {
          return [];
        },
      };
      const report = await analyzeDeployments(idx, failing, {
        script_id_by_project: new Map([[idx.project, 'sid-app']]),
      });
      const p = report.projects[0]!;
      expect(p.fetch_error).toContain('HTTP 403');
      // Toutes les fonctions du projet en `unknown`.
      expect(report.function_annotations.every((a) => a.deployment_status === 'unknown')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('renderDeployAwareText produit une sortie texte cohérente', async () => {
    const root = await makeProject({
      'appsscript.json': '{}',
      'main.gs': 'function doGet(){} function helper(){}',
    });
    try {
      const idx = await scanProject({ root });
      const provider = stubProvider([webAppDeployment]);
      const report = await analyzeDeployments(idx, provider, {
        script_id_by_project: new Map([[idx.project, 'sid-app']]),
      });
      const text = renderDeployAwareText(report);
      expect(text).toContain('deploy-aware');
      expect(text).toContain('live_web_app');
      expect(text).toContain('AKfycbz-LIVE');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('createAppsScriptDeploymentsProvider — fetch + cache', () => {
  it('appelle deployments + versions et mappe le payload Google', async () => {
    const mock = await startMockServer((req) => {
      if (req.pathname.endsWith('/deployments')) {
        return {
          status: 200,
          body: {
            deployments: [
              {
                deploymentId: 'd1',
                deploymentConfig: { versionNumber: 7, description: 'web app prod' },
                entryPoints: [
                  {
                    entryPointType: 'WEB_APP',
                    webApp: {
                      url: 'https://x',
                      executeAs: 'USER_DEPLOYING',
                      access: 'ANYONE',
                    },
                  },
                ],
                updateTime: '2026-06-01T00:00:00Z',
              },
            ],
          },
        };
      }
      if (req.pathname.endsWith('/versions')) {
        return {
          status: 200,
          body: {
            versions: [
              {
                versionNumber: 7,
                description: 'v7',
                createTime: '2026-06-01T00:00:00Z',
              },
            ],
          },
        };
      }
      return { status: 404, body: {} };
    });
    try {
      const provider = await createAppsScriptDeploymentsProvider({
        baseUrl: mock.url,
        getAccessToken: async () => 'tok',
      });
      const d = await provider.listDeployments('sid');
      const v = await provider.listVersions('sid');
      expect(d).toHaveLength(1);
      expect(d[0]?.deployment_id).toBe('d1');
      expect(d[0]?.version_number).toBe(7);
      expect(d[0]?.entry_points[0]?.type).toBe('WEB_APP');
      expect(d[0]?.entry_points[0]?.access).toBe('ANYONE');
      expect(v).toHaveLength(1);
      expect(v[0]?.version_number).toBe(7);
    } finally {
      await mock.close();
    }
  });

  it('cache mémoire : 2e appel = 0 hit serveur', async () => {
    const mock = await startMockServer((req) => {
      if (req.pathname.endsWith('/deployments')) {
        return { status: 200, body: { deployments: [] } };
      }
      return { status: 200, body: { versions: [] } };
    });
    try {
      const provider = await createAppsScriptDeploymentsProvider({
        baseUrl: mock.url,
        getAccessToken: async () => 'tok',
      });
      await provider.listDeployments('sid');
      await provider.listDeployments('sid');
      await provider.listVersions('sid');
      await provider.listVersions('sid');
      // 1 hit deployments + 1 hit versions, pas 4.
      expect(mock.requests.filter((r) => r.endsWith('/deployments'))).toHaveLength(1);
      expect(mock.requests.filter((r) => r.endsWith('/versions'))).toHaveLength(1);
    } finally {
      await mock.close();
    }
  });

  it('500 → throw (rattrapé par loadProjectSummary → fetch_error)', async () => {
    const mock = await startMockServer(() => ({
      status: 500,
      body: { error: 'internal' },
    }));
    try {
      const provider = await createAppsScriptDeploymentsProvider({
        baseUrl: mock.url,
        getAccessToken: async () => 'tok',
      });
      await expect(provider.listDeployments('sid')).rejects.toThrow(/HTTP 500/);
    } finally {
      await mock.close();
    }
  });

  it('pagination : suit nextPageToken jusqu à plafond', async () => {
    const mock = await startMockServer((req, page) => {
      if (req.pathname.endsWith('/deployments')) {
        if (page === 0) {
          return {
            status: 200,
            body: {
              deployments: [
                {
                  deploymentId: 'd1',
                  deploymentConfig: { versionNumber: 1 },
                  entryPoints: [],
                },
              ],
              nextPageToken: 'p2',
            },
          };
        }
        return {
          status: 200,
          body: {
            deployments: [
              {
                deploymentId: 'd2',
                deploymentConfig: { versionNumber: 2 },
                entryPoints: [],
              },
            ],
          },
        };
      }
      return { status: 200, body: { versions: [] } };
    });
    try {
      const provider = await createAppsScriptDeploymentsProvider({
        baseUrl: mock.url,
        getAccessToken: async () => 'tok',
      });
      const d = await provider.listDeployments('sid');
      expect(d).toHaveLength(2);
      expect(d.map((x) => x.deployment_id)).toEqual(['d1', 'd2']);
    } finally {
      await mock.close();
    }
  });
});

describe('intégration analyzeDeployments + AppsScriptDeploymentsProvider', () => {
  it('end-to-end : fetch + classification', async () => {
    const mock = await startMockServer((req) => {
      if (req.pathname.endsWith('/deployments')) {
        return {
          status: 200,
          body: {
            deployments: [
              {
                deploymentId: 'd1',
                deploymentConfig: { versionNumber: 1, description: 'web app' },
                entryPoints: [
                  {
                    entryPointType: 'WEB_APP',
                    webApp: { url: 'https://x', executeAs: 'USER_DEPLOYING', access: 'ANYONE' },
                  },
                ],
              },
            ],
          },
        };
      }
      return { status: 200, body: { versions: [{ versionNumber: 1 }] } };
    });
    const root = await makeProject({
      'appsscript.json': '{}',
      'main.gs': 'function doGet(){ return ContentService.createTextOutput("hi"); }',
    });
    try {
      const idx = await scanProject({ root });
      const provider = await createAppsScriptDeploymentsProvider({
        baseUrl: mock.url,
        getAccessToken: async () => 'tok',
      });
      const report = await analyzeDeployments(idx, provider, {
        script_id_by_project: new Map([[idx.project, 'sid-app']]),
      });
      const doGet = report.function_annotations.find((a) => a.function_name === 'doGet')!;
      expect(doGet.deployment_status).toBe('live_web_app');
      expect(report.summary.functions_live_web_app).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
      await mock.close();
    }
  });
});
