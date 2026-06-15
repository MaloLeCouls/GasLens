import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type {
  CallerInfo,
  ClientHandlerRef,
  Coverage,
  CrossProjectEdge,
  Exposure,
  FunctionRecord,
  PendingLibraryCall,
  ProjectIndex,
  ReceiverUsage,
  ScriptletKindLabel,
  UnresolvedCall,
  WorkspaceIndex,
} from './types.js';
import { parseSource } from './parser.js';
import { extractDefinitions, type RawDefinition } from './extract/definitions.js';
import { extractCallSites, type RawCallSite } from './extract/calls.js';
import {
  exposuresFromName,
  installableTriggersFromCalls,
} from './extract/exposures.js';
import { readManifest } from './manifest.js';
import { GAS_BUILTIN_SERVICES } from './gas-services.js';
import {
  extractHtmlChunks,
  translatePosition,
  type HtmlChunk,
} from './extract/html.js';
import {
  findGoogleScriptRunCalls,
  type GsrCall,
  type GsrHandler,
} from './extract/google-script-run.js';
import {
  extractTopLevelFunctions,
  readFieldsOnParam,
  type ScriptFunctionEntry,
} from './extract/handler-shapes.js';
import { extractGasPatterns } from './extract/gas-patterns.js';
import { analyzeReturns } from './extract/return-analysis.js';
import { analyzeUncertainty } from './extract/uncertainty.js';
import type {
  FieldRead,
  InferredContract,
  PropertyKeyEntry,
  PropertyStore,
  ReturnAnalysis,
} from './types.js';

export interface ScanOptions {
  /** Racine du projet à scanner. */
  root: string;
}

interface FileBundle {
  fileRel: string;
  defs: RawDefinition[];
  topLevelCalls: RawCallSite[];
}

interface HtmlFileBundle {
  fileRel: string;
  /** Exposures à attacher : `target_name` → Exposure[] */
  clientCalls: Map<string, Exposure[]>;
  scriptletCalls: Map<string, Exposure[]>;
  /** Contributions au contrat inféré, indexées par nom de fonction serveur. */
  contractContributions: Map<string, ContractContribution>;
  /** Champs `data.X` lus dans les scriptlets côté template. */
  scriptletDataReads: Set<string>;
  /** Notes coverage à émettre côté record si la fonction cible n'existe pas. */
  unresolved: UnresolvedCall[];
}

interface ContractContribution {
  success_fields: FieldRead[];
  failure_fields: FieldRead[];
  unresolved_handlers: InferredContract['unresolved_handlers'];
}

export async function scanProject(opts: ScanOptions): Promise<ProjectIndex> {
  const manifest = await readManifest(opts.root);
  const libraryPrefixes = new Set(manifest.libraryPrefixes);

  const { gsFiles, htmlFiles } = await collectSourceFiles(opts.root);
  const bundles: FileBundle[] = [];
  for (const absPath of gsFiles) {
    const rel = toPosix(relative(opts.root, absPath));
    const source = await readFile(absPath, 'utf8');
    const tree = parseSource(source);
    const defs = extractDefinitions(tree.rootNode, rel);
    const topLevelCalls = extractCallSites(tree.rootNode);
    bundles.push({ fileRel: rel, defs, topLevelCalls });
  }

  const htmlBundles: HtmlFileBundle[] = [];
  for (const absPath of htmlFiles) {
    const rel = toPosix(relative(opts.root, absPath));
    const source = await readFile(absPath, 'utf8');
    htmlBundles.push(processHtmlFile(rel, source));
  }

  // Pass 1 : construire les records et l'index { nom → record }.
  // GAS partage un namespace global au sein d'un projet : par défaut une fonction
  // d'un .gs est résolue depuis n'importe quel autre .gs du même projet.
  // En cas de collision (deux .gs définissent `foo`), on garde le premier et on
  // signale le second en unresolved (la plateforme GAS lèverait à l'exécution).
  const records = new Map<string, FunctionRecord>();
  const collisions: UnresolvedCall[] = [];

  for (const b of bundles) {
    for (const def of b.defs) {
      const id = `${manifest.projectName}::${b.fileRel}::${def.name}`;
      if (records.has(def.name)) {
        collisions.push({
          file: b.fileRel,
          line: def.definition.line,
          callee_text: def.name,
          reason: `collision de namespace : '${def.name}' déjà défini ailleurs dans le projet`,
        });
        continue;
      }
      const rec: FunctionRecord = {
        id,
        name: def.name,
        project: manifest.projectName,
        definition: def.definition,
        exposures: exposuresFromName(
          def.name,
          def.definition.file,
          def.definition.line,
        ),
        calls_out: [],
        called_by: [],
        inferred_contract: null,
        patterns: {
          destructuring_contracts: [],
          property_keys: [],
          array2d_access: [],
          template_bindings: [],
        },
        return_analysis: emptyReturnAnalysis(),
        coverage: emptyCoverage(),
      };
      records.set(def.name, rec);
    }
  }

  // Pass 2 : appels.
  //   - calls_out : pour chaque def, calls dans son corps.
  //   - called_by : pour chaque appel résolu en interne, ajouter à la cible.
  //   - exposures par chaîne (ScriptApp.newTrigger('X')).
  //   - unresolved.
  const unresolved: UnresolvedCall[] = [];
  const pending_library_calls: PendingLibraryCall[] = [];
  const receiver_usage: ReceiverUsage[] = [];
  for (const b of bundles) {
    // a) Expositions installable_trigger : sur *tout* le fichier, peu importe le caller.
    const trigMap = installableTriggersFromCalls(b.topLevelCalls, b.fileRel);
    for (const [targetName, exposures] of trigMap) {
      const rec = records.get(targetName);
      if (rec) {
        rec.exposures.push(...exposures);
      } else {
        unresolved.push({
          file: exposures[0]!.file,
          line: exposures[0]!.line,
          callee_text: targetName,
          reason: `ScriptApp.newTrigger('${targetName}') — fonction cible non trouvée dans le projet`,
        });
      }
    }

    // b) Pour chaque def, parcourir son body et résoudre les appels +
    //    extraire les patrons GAS + analyser le retour + incertitudes.
    for (const def of b.defs) {
      const rec = records.get(def.name);
      if (!rec) continue; // collision : sauté en pass 1
      rec.patterns = extractGasPatterns(def.bodyNode, b.fileRel);
      rec.return_analysis = analyzeReturns(def.bodyNode, b.fileRel);
      // Couverture : sources d'incertitude statique (dispatch dynamique, eval...).
      const uncertaintyNotes = analyzeUncertainty(def.bodyNode, b.fileRel);
      if (uncertaintyNotes.length > 0) {
        rec.coverage.unresolved.push(...uncertaintyNotes);
      }
      // Open-object dans le retour → coverage note explicite.
      if (rec.return_analysis.has_open_object) {
        rec.coverage.unresolved.push({
          what: 'retour contient un objet à clé(s) calculée(s)',
          where: `${rec.definition.file}:${rec.definition.line}`,
          reason: 'la shape de retour ne peut pas être fermée statiquement',
          suggestion: 'préférer des clés littérales ou documenter la shape attendue côté consommateurs',
        });
      }
      const calls = extractCallSites(def.bodyNode);
      const seenOut = new Set<string>();
      for (const call of calls) {
        const resolution = resolveCall(call, records, libraryPrefixes);
        if (call.receiver !== null) {
          const root = rootReceiver(call.receiver);
          if (root !== null && isCapitalizedReceiver(root)) {
            receiver_usage.push({
              receiver: root,
              method: call.final_name,
              function: def.name,
              file: b.fileRel,
              line: call.line,
            });
          }
        }
        switch (resolution.kind) {
          case 'internal': {
            const target = records.get(resolution.name)!;
            if (!seenOut.has(target.name)) {
              rec.calls_out.push(target.name);
              seenOut.add(target.name);
            }
            const caller: CallerInfo = {
              file: b.fileRel,
              line: call.line,
              caller: def.name,
              arguments_text: call.arguments_text,
              return_used_as: returnUsedAs(call.node),
            };
            target.called_by.push(caller);
            break;
          }
          case 'external_gas_service': {
            const label = `${resolution.receiver}.${call.final_name}`;
            if (!seenOut.has(label)) {
              rec.calls_out.push(label);
              seenOut.add(label);
            }
            break;
          }
          case 'external_library': {
            const label = `${resolution.receiver}.${call.final_name}`;
            if (!seenOut.has(label)) {
              rec.calls_out.push(label);
              seenOut.add(label);
            }
            // On note la frontière externe au niveau record (sera résolue plus
            // tard si le préfixe correspond à un autre projet du workspace).
            const note = `librairie '${resolution.receiver}' (projet externe non indexé)`;
            if (!rec.coverage.external_boundaries.includes(note)) {
              rec.coverage.external_boundaries.push(note);
            }
            // Mémoriser le call site pour la passe cross-project (scanWorkspace).
            pending_library_calls.push({
              library_prefix: resolution.receiver,
              method: call.final_name,
              caller_function: def.name,
              caller_file: b.fileRel,
              caller_line: call.line,
              caller_arguments: call.arguments_text,
              return_used_as: returnUsedAs(call.node),
            });
            break;
          }
          case 'unresolved_bare': {
            unresolved.push({
              file: b.fileRel,
              line: call.line,
              callee_text: call.callee_text,
              reason: 'identifier non résolu dans le namespace projet',
            });
            rec.coverage.unresolved.push({
              what: `appel à '${call.callee_text}' non résolu`,
              where: `${b.fileRel}:${call.line}`,
              reason:
                "le nom n'est défini ni dans le projet ni comme service GAS connu",
              suggestion: 'vérifier l\'orthographe ou un import manquant',
            });
            rec.coverage.confidence = 'medium';
            break;
          }
          case 'skipped':
            break;
        }
      }
    }
  }

  // Pass 3 : HTML. Pour chaque exposure client_call / scriptlet détectée,
  // retrouver le record correspondant et l'attacher.
  for (const h of htmlBundles) {
    for (const [name, exposures] of h.clientCalls) {
      const rec = records.get(name);
      if (!rec) {
        unresolved.push(
          ...exposures.map((e) => ({
            file: e.file,
            line: e.line,
            callee_text: `google.script.run.${name}`,
            reason: `appel google.script.run.${name} — fonction serveur '${name}' introuvable dans le projet`,
          })),
        );
        continue;
      }
      if (rec.definition.visibility === 'private') {
        // V1 §3.5 : les fonctions à suffixe _ sont invisibles à google.script.run.
        for (const e of exposures) {
          e.detail =
            (e.detail ? e.detail + ' ; ' : '') +
            `⚠ fonction privée (suffixe _) — google.script.run ne peut PAS l'appeler à l'exécution`;
        }
      }
      rec.exposures.push(...exposures);
    }
    for (const [name, exposures] of h.scriptletCalls) {
      const rec = records.get(name);
      if (!rec) {
        // Bare identifier non résolu dans un scriptlet : potentiellement un
        // builtin ou une var locale au template — pas d'erreur bruyante.
        continue;
      }
      rec.exposures.push(...exposures);
    }
    for (const [name, contrib] of h.contractContributions) {
      const rec = records.get(name);
      if (!rec) continue; // déjà reporté en unresolved côté clientCalls
      mergeIntoContract(rec, contrib);
    }
    unresolved.push(...h.unresolved);
  }

  // Pass 4 : cross-link des template_bindings avec les `data.X` lus côté HTML.
  const dataReadsByFile = new Map<string, Set<string>>();
  for (const h of htmlBundles) {
    dataReadsByFile.set(h.fileRel, h.scriptletDataReads);
  }
  for (const rec of records.values()) {
    for (const tb of rec.patterns.template_bindings) {
      const reads = dataReadsByFile.get(tb.template_file);
      if (!reads) continue;
      tb.data_fields_read_in_scriptlets = [...reads].sort();
      const setFields = new Set(tb.data_fields_set);
      tb.unread_data_fields = tb.data_fields_set.filter((f) => !reads.has(f));
      tb.read_but_not_set = [...reads]
        .filter((f) => !setFields.has(f))
        .sort();
    }
  }

  // Pass 5 : index projet des clés PropertiesService/CacheService.
  const property_keys = buildPropertyKeysIndex(records);

  // Finaliser la couverture des records sans soucis détectés.
  for (const rec of records.values()) {
    finalizeCoverage(rec.coverage);
  }

  // Pass 6 : synthèse coverage au niveau projet (V1 §1.5, V2 §10.4).
  const coverage_summary = buildCoverageSummary(records);

  const orderedFiles = [
    ...bundles.map((b) => b.fileRel),
    ...htmlBundles.map((h) => h.fileRel),
  ].sort();

  return {
    kind: 'project',
    project: manifest.projectName,
    root: opts.root,
    scanned_at: new Date().toISOString(),
    files: orderedFiles,
    functions: Array.from(records.values()).sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    ),
    property_keys,
    pending_library_calls,
    receiver_usage,
    manifest: manifest.manifest,
    coverage_summary,
    unresolved_calls: [...collisions, ...unresolved],
  };
}

function buildCoverageSummary(
  records: Map<string, FunctionRecord>,
): import('./types.js').ProjectCoverageSummary {
  const all = [...records.values()];
  const total_unresolved = all.reduce(
    (n, r) => n + r.coverage.unresolved.length,
    0,
  );
  const unresolved_by_kind: Record<string, number> = {};
  for (const r of all) {
    for (const u of r.coverage.unresolved) {
      const key = classifyUnresolved(u.what);
      unresolved_by_kind[key] = (unresolved_by_kind[key] ?? 0) + 1;
    }
  }
  const functions_with_open_returns: string[] = [];
  const functions_with_dynamic_dispatch: string[] = [];
  const functions_with_non_serializable_returns: string[] = [];
  for (const r of all) {
    if (r.return_analysis.has_open_object) {
      functions_with_open_returns.push(r.name);
    }
    if (r.return_analysis.serializable === false) {
      functions_with_non_serializable_returns.push(r.name);
    }
    if (
      r.coverage.unresolved.some((u) => u.what.startsWith('dispatch dynamique'))
    ) {
      functions_with_dynamic_dispatch.push(r.name);
    }
  }
  // Moyenne pondérée des resolved_pct par fonction.
  const avgPct = all.length === 0
    ? 100
    : Math.round(all.reduce((n, r) => n + r.coverage.resolved_pct, 0) / all.length);
  const confidence: 'high' | 'medium' | 'low' =
    avgPct >= 95 ? 'high' : avgPct >= 80 ? 'medium' : 'low';
  return {
    resolved_pct: avgPct,
    confidence,
    total_unresolved,
    unresolved_by_kind,
    functions_with_open_returns,
    functions_with_dynamic_dispatch,
    functions_with_non_serializable_returns,
  };
}

function classifyUnresolved(what: string): string {
  if (what.startsWith('dispatch dynamique')) return 'dynamic_dispatch';
  if (what.startsWith('appel à eval')) return 'eval';
  if (what.startsWith('new Function')) return 'new_function';
  if (what.startsWith('retour contient un objet à clé')) return 'computed_key_in_return';
  if (what.startsWith("appel à '")) return 'unresolved_identifier';
  return 'other';
}

/**
 * Scan multi-projets. Détecte les sous-dossiers contenant un `appsscript.json`,
 * scanne chacun, puis résout les appels `LibName.fn()` entre projets en faisant
 * matcher le `userSymbol` déclaré dans le manifeste appelant avec le `project`
 * (basename du dossier) d'un autre projet du workspace (V1 §3.7).
 *
 * Si un seul projet est détecté → renvoie un ProjectIndex (compat single-repo).
 */
export async function scanWorkspace(opts: {
  root: string;
}): Promise<WorkspaceIndex | ProjectIndex> {
  const projectRoots = await findProjectRoots(opts.root);
  if (projectRoots.length === 0) {
    // pas de manifeste : on traite quand même `root` comme un projet implicite.
    return scanProject({ root: opts.root });
  }
  if (projectRoots.length === 1) {
    return scanProject({ root: projectRoots[0]! });
  }

  const projects: ProjectIndex[] = [];
  for (const r of projectRoots) {
    projects.push(await scanProject({ root: r }));
  }

  const projectByName = new Map(projects.map((p) => [p.project, p]));
  const cross_project_edges: CrossProjectEdge[] = [];

  for (const callerProject of projects) {
    for (const pc of callerProject.pending_library_calls) {
      const targetProject = projectByName.get(pc.library_prefix);
      if (!targetProject) continue;
      const targetFn = targetProject.functions.find(
        (f) => f.name === pc.method,
      );
      if (!targetFn) continue;
      if (targetFn.definition.visibility === 'private') continue;

      const caller: CallerInfo = {
        file: pc.caller_file,
        line: pc.caller_line,
        caller: pc.caller_function,
        arguments_text: pc.caller_arguments,
        return_used_as: pc.return_used_as,
        caller_project: callerProject.project,
      };
      targetFn.called_by.push(caller);

      targetFn.exposures.push({
        type: 'library',
        file: `${callerProject.project}/${pc.caller_file}`,
        line: pc.caller_line,
        detail: `appelée depuis '${callerProject.project}' via préfixe '${pc.library_prefix}'`,
      });

      cross_project_edges.push({
        caller_project: callerProject.project,
        caller_function: pc.caller_function,
        caller_file: pc.caller_file,
        caller_line: pc.caller_line,
        callee_project: targetProject.project,
        callee_function: targetFn.name,
        library_prefix: pc.library_prefix,
      });
    }
  }

  return {
    kind: 'workspace',
    workspace_root: opts.root,
    scanned_at: new Date().toISOString(),
    projects,
    cross_project_edges,
  };
}

async function findProjectRoots(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const hasManifest = entries.some(
      (e) => e.isFile() && e.name === 'appsscript.json',
    );
    if (hasManifest) {
      out.push(dir);
      return; // pas de descente sous un projet (pas de nested projects attendus)
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      await walk(join(dir, e.name));
    }
  }
  try {
    const s = await stat(root);
    if (s.isDirectory()) await walk(root);
  } catch {
    return [];
  }
  return out.sort();
}

function buildPropertyKeysIndex(
  records: Map<string, FunctionRecord>,
): PropertyKeyEntry[] {
  const bucket = new Map<string, PropertyKeyEntry>();
  for (const rec of records.values()) {
    for (const pk of rec.patterns.property_keys) {
      if (pk.key === null) continue; // clé dynamique : non agrégée (ira en coverage)
      const k = `${pk.store}::${pk.key}`;
      let entry = bucket.get(k);
      if (!entry) {
        entry = {
          key: pk.key,
          store: pk.store,
          reads: [],
          writes: [],
          deletes: [],
          status: 'ok',
        };
        bucket.set(k, entry);
      }
      const loc = { file: pk.at.file, line: pk.at.line, function: rec.name };
      if (pk.op === 'read') entry.reads.push(loc);
      else if (pk.op === 'write') entry.writes.push(loc);
      else entry.deletes.push(loc);
    }
  }
  for (const e of bucket.values()) {
    if (e.reads.length === 0 && e.writes.length > 0) e.status = 'write_only';
    else if (e.writes.length === 0 && e.reads.length > 0) e.status = 'read_only';
    else e.status = 'ok';
  }
  return [...bucket.values()].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
}

function processHtmlFile(fileRel: string, source: string): HtmlFileBundle {
  const chunks = extractHtmlChunks(source);
  const clientCalls = new Map<string, Exposure[]>();
  const scriptletCalls = new Map<string, Exposure[]>();
  const contractContributions = new Map<string, ContractContribution>();
  const scriptletDataReads = new Set<string>();
  const unresolved: UnresolvedCall[] = [];

  // Détectées en streaming, résolues en fin de boucle (les handlers définis APRÈS
  // l'appel dans le même bloc <script> doivent être trouvés aussi).
  const pendingGsr: Array<{ chunk: HtmlChunk; call: GsrCall }> = [];
  // Index global du fichier : nom → (entrée + chunk où elle est définie).
  const scriptFunctions = new Map<
    string,
    { entry: ScriptFunctionEntry; chunk: HtmlChunk }
  >();

  for (const chunk of chunks) {
    const tree = parseSource(chunk.source);
    if (chunk.kind === 'script') {
      // a) Chaînes google.script.run dans le bloc.
      for (const g of findGoogleScriptRunCalls(tree.rootNode)) {
        pendingGsr.push({ chunk, call: g });
      }
      // b) Définitions de fonctions top-level (candidates handlers).
      for (const [name, entry] of extractTopLevelFunctions(tree.rootNode)) {
        if (!scriptFunctions.has(name)) {
          scriptFunctions.set(name, { entry, chunk });
        }
      }
    } else {
      // Scriptlet : tout appel à un identifier bare est candidat à un appel serveur
      // (les scriptlets s'exécutent côté serveur au rendu).
      const calls = extractCallSites(tree.rootNode);
      const kind: ScriptletKindLabel = chunk.kind;
      for (const c of calls) {
        if (!c.is_bare_identifier) continue;
        const pos = translatePosition(chunk, c.line - 1, c.col);
        const exp: Exposure = {
          type: 'scriptlet',
          file: fileRel,
          line: pos.line,
          detail: `${kind} ${c.final_name}(...) ${kind === '<?' ? '' : '?>'}`.trim(),
          scriptlet_kind: kind,
          arguments_text: c.arguments_text,
        };
        push(scriptletCalls, c.final_name, exp);
      }
      // Détecter les `data.X` lus dans le scriptlet — alimente template_bindings.
      for (const me of tree.rootNode.descendantsOfType('member_expression')) {
        const obj = me.childForFieldName('object');
        const prop = me.childForFieldName('property');
        if (!obj || obj.type !== 'identifier' || obj.text !== 'data') continue;
        if (!prop || prop.type !== 'property_identifier') continue;
        scriptletDataReads.add(prop.text);
      }
    }
  }

  // Maintenant qu'on a vu *toutes* les définitions de handlers du fichier,
  // résoudre les appels GSR et inférer le contrat.
  for (const { chunk, call } of pendingGsr) {
    const callPos = translatePosition(chunk, call.line - 1, call.col);
    const exp: Exposure = {
      type: 'client_call',
      file: fileRel,
      line: callPos.line,
      detail: `google.script.run.${call.server_function}(...)`,
      success_handler: translateHandler(chunk, call.success_handler),
      failure_handler: translateHandler(chunk, call.failure_handler),
      user_object: call.user_object,
      arguments_text: call.arguments_text,
    };
    push(clientCalls, call.server_function, exp);

    const contribution = ensureContribution(
      contractContributions,
      call.server_function,
    );
    inferShapeFromHandler(
      call.success_handler,
      scriptFunctions,
      fileRel,
      'success',
      contribution,
    );
    inferShapeFromHandler(
      call.failure_handler,
      scriptFunctions,
      fileRel,
      'failure',
      contribution,
    );
  }

  return {
    fileRel,
    clientCalls,
    scriptletCalls,
    contractContributions,
    scriptletDataReads,
    unresolved,
  };
}

function ensureContribution(
  map: Map<string, ContractContribution>,
  serverName: string,
): ContractContribution {
  let c = map.get(serverName);
  if (!c) {
    c = { success_fields: [], failure_fields: [], unresolved_handlers: [] };
    map.set(serverName, c);
  }
  return c;
}

function inferShapeFromHandler(
  handler: GsrHandler | null,
  scriptFunctions: Map<string, { entry: ScriptFunctionEntry; chunk: HtmlChunk }>,
  fileRel: string,
  kind: 'success' | 'failure',
  out: ContractContribution,
): void {
  if (!handler) return;
  if (handler.inline) {
    out.unresolved_handlers.push({
      kind,
      reason: 'handler inline (function expression / arrow) — non analysé en v0',
      where: `${fileRel}:${handler.line}`,
    });
    return;
  }
  const lookup = scriptFunctions.get(handler.name);
  if (!lookup) {
    out.unresolved_handlers.push({
      kind,
      reason: `handler '${handler.name}' référencé mais non défini dans les <script> du même HTML`,
      where: `${fileRel}:${handler.line}`,
    });
    return;
  }
  const { entry, chunk } = lookup;
  if (!entry.firstParamName) {
    out.unresolved_handlers.push({
      kind,
      reason: `handler '${handler.name}' n'a pas de paramètre (ou destructuration) — la shape n'est pas dérivable`,
      where: `${fileRel}:${handler.line}`,
    });
    return;
  }
  const hits = readFieldsOnParam(entry.bodyNode, entry.firstParamName);
  for (const h of hits) {
    const p = translatePosition(chunk, h.chunk_row, h.chunk_col);
    const read: FieldRead = {
      field: h.field,
      handler: handler.name,
      file: fileRel,
      line: p.line,
    };
    if (kind === 'success') out.success_fields.push(read);
    else out.failure_fields.push(read);
  }
}

function translateHandler(
  chunk: HtmlChunk,
  h: { name: string; inline: boolean; line: number; col: number } | null,
): ClientHandlerRef | null {
  if (!h) return null;
  const p = translatePosition(chunk, h.line - 1, h.col);
  return { name: h.name, inline: h.inline, line: p.line, col: p.col };
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const arr = map.get(key) ?? [];
  arr.push(value);
  map.set(key, arr);
}

function mergeIntoContract(rec: FunctionRecord, c: ContractContribution): void {
  if (!rec.inferred_contract) {
    rec.inferred_contract = {
      return_shape: null,
      failure_signal: null,
      unresolved_handlers: [],
    };
  }
  const ic = rec.inferred_contract;
  if (c.success_fields.length > 0) {
    if (!ic.return_shape) {
      ic.return_shape = {
        fields_read: [],
        field_names: [],
        source: 'success_handler_consumption',
      };
    }
    ic.return_shape.fields_read.push(...c.success_fields);
    ic.return_shape.field_names = dedupe(
      ic.return_shape.fields_read.map((f) => f.field),
    );
  }
  if (c.failure_fields.length > 0) {
    if (!ic.failure_signal) {
      ic.failure_signal = { fields_read: [], field_names: [] };
    }
    ic.failure_signal.fields_read.push(...c.failure_fields);
    ic.failure_signal.field_names = dedupe(
      ic.failure_signal.fields_read.map((f) => f.field),
    );
  }
  ic.unresolved_handlers.push(...c.unresolved_handlers);
}

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

type CallResolution =
  | { kind: 'internal'; name: string }
  | { kind: 'external_gas_service'; receiver: string }
  | { kind: 'external_library'; receiver: string }
  | { kind: 'unresolved_bare' }
  | { kind: 'skipped' };

function resolveCall(
  call: RawCallSite,
  records: Map<string, FunctionRecord>,
  libraryPrefixes: Set<string>,
): CallResolution {
  if (call.is_bare_identifier) {
    if (records.has(call.final_name)) {
      return { kind: 'internal', name: call.final_name };
    }
    if (isJsBuiltin(call.final_name)) return { kind: 'skipped' };
    return { kind: 'unresolved_bare' };
  }
  if (call.receiver && GAS_BUILTIN_SERVICES.has(call.receiver)) {
    return { kind: 'external_gas_service', receiver: call.receiver };
  }
  if (call.receiver && libraryPrefixes.has(call.receiver)) {
    return { kind: 'external_library', receiver: call.receiver };
  }
  // Autre member_expression : chaînage (`x.y.z()`), variable locale, etc.
  // v0 — non résolu mais pas remonté en bruit.
  return { kind: 'skipped' };
}

function isJsBuiltin(name: string): boolean {
  return JS_GLOBALS.has(name);
}

/**
 * Filtre les receivers qui ressemblent à un nom *top-level* de service ou
 * librairie : identifiant simple, commençant par une majuscule.
 */
function isCapitalizedReceiver(name: string): boolean {
  return /^[A-Z][a-zA-Z0-9_$]*$/.test(name);
}

/**
 * Extrait l'identifiant racine d'un texte de receiver tel que rendu par
 * `RawCallSite.receiver` (qui peut être une expression chaînée arbitraire
 * pour `A.b.c()` ou `f().x.y()`). Renvoie null si la racine n'est pas un
 * identifiant nu (ex: `(x + y).fn()`, `arr[0].fn()`).
 */
function rootReceiver(text: string): string | null {
  // On coupe au premier séparateur structurel : `.`, `(`, `[`, espace, etc.
  const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(text);
  return m ? m[0] : null;
}
const JS_GLOBALS = new Set<string>([
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'String',
  'Number',
  'Boolean',
  'Object',
  'Array',
  'Date',
  'Math',
  'JSON',
  'RegExp',
  'Error',
  'TypeError',
  'RangeError',
  'Promise',
  'Symbol',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'encodeURIComponent',
  'decodeURIComponent',
  'encodeURI',
  'decodeURI',
]);

// Pour v0 : retourne 'returned' si l'appel est un argument direct de return_statement,
// 'assigned:<name>' s'il est la valeur d'un variable_declarator, sinon null.
function returnUsedAs(callNode: import('tree-sitter').SyntaxNode): string | null {
  const parent = callNode.parent;
  if (!parent) return null;
  if (parent.type === 'return_statement') return 'returned';
  if (parent.type === 'variable_declarator') {
    const name = parent.childForFieldName('name');
    if (name && name.type === 'identifier') return `assigned:${name.text}`;
  }
  if (parent.type === 'assignment_expression') {
    const left = parent.childForFieldName('left');
    if (left) return `assigned:${left.text}`;
  }
  return null;
}

function emptyCoverage(): Coverage {
  return {
    resolved_pct: 100,
    confidence: 'high',
    unresolved: [],
    external_boundaries: [],
  };
}

function emptyReturnAnalysis(): ReturnAnalysis {
  return {
    nullable: false,
    null_paths: [],
    serializable: 'unknown',
    non_serializable_reasons: [],
    has_open_object: false,
  };
}

function finalizeCoverage(c: Coverage): void {
  if (c.unresolved.length === 0) return;
  // Heuristique grossière : on baisse le pct en fonction du nombre d'unresolved.
  // Ce sera affiné par le moteur de shapes en v1.
  const penalty = Math.min(40, c.unresolved.length * 5);
  c.resolved_pct = Math.max(50, 100 - penalty);
  if (c.confidence === 'high') c.confidence = 'medium';
}

async function collectSourceFiles(
  root: string,
): Promise<{ gsFiles: string[]; htmlFiles: string[] }> {
  const gsFiles: string[] = [];
  const htmlFiles: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        await walk(p);
      } else if (e.isFile()) {
        if (e.name.endsWith('.gs')) gsFiles.push(p);
        else if (e.name.endsWith('.html') || e.name.endsWith('.htm')) {
          htmlFiles.push(p);
        }
      }
    }
  }
  const s = await stat(root);
  if (s.isDirectory()) await walk(root);
  else if (root.endsWith('.gs')) gsFiles.push(root);
  else if (root.endsWith('.html') || root.endsWith('.htm')) htmlFiles.push(root);
  return { gsFiles: gsFiles.sort(), htmlFiles: htmlFiles.sort() };
}

function toPosix(p: string): string {
  return sep === '\\' ? p.split('\\').join('/') : p;
}
