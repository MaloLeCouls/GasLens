/**
 * Modèle de données indexé pour une fonction GAS.
 * Sous-ensemble du V1 §4.2, scanner v0 (sans inferred_contract ni shapes).
 */

export interface Position {
  line: number;
  col: number;
}

export interface Param {
  name: string;
  jsdoc_type: string | null;
  desc: string | null;
}

export interface ReturnDoc {
  jsdoc_type: string | null;
  desc: string | null;
}

export type Visibility = 'public' | 'private';

export interface FunctionDefinition {
  file: string;
  line: number;
  col: number;
  end_line: number;
  params: Param[];
  returns: ReturnDoc | null;
  visibility: Visibility;
  /** @deprecated — utiliser FunctionRecord.return_analysis.serializable. */
  serializable_return: boolean | null;
  /**
   * Empreinte du corps de la fonction (V2 §13.2) — sert à la détection de
   * renommage façon git. Whitespace normalisé, hash SHA-256 16 hex chars.
   */
  body_fingerprint: string;
}

export interface ReturnAnalysis {
  /** Vrai si au moins un chemin renvoie `null`/`undefined`/`return` sans valeur. */
  nullable: boolean;
  /** Positions des retours nullables (pour reporting + diff). */
  null_paths: Array<{ file: string; line: number }>;
  /**
   * Sérialisabilité du retour à travers google.script.run (V2 §11.5).
   *   true  — composé de primitives, Date, arrays, plain objects ;
   *   false — contient `new X()` autre que Date, ou function expression ;
   *   'unknown' — pas de retour analysable.
   */
  serializable: true | false | 'unknown';
  /** Constructeurs non-sérialisables détectés dans les retours. */
  non_serializable_reasons: Array<{
    file: string;
    line: number;
    reason: string;
  }>;
  /**
   * Vrai si le retour utilise un objet avec clé(s) calculée(s) (`{[k]: v}`) →
   * la shape ne peut pas être fermée statiquement.
   */
  has_open_object: boolean;
}

export type ExposureType =
  | 'entry_point_web'
  | 'simple_trigger'
  | 'installable_trigger'
  | 'client_call'
  | 'scriptlet'
  | 'library';

export interface ClientHandlerRef {
  name: string;
  inline: boolean;
  line: number;
  col: number;
}

export type ScriptletKindLabel = '<?' | '<?=' | '<?!=';

export interface Exposure {
  type: ExposureType;
  file: string;
  line: number;
  detail?: string;
  /** Pour `client_call` : nom + position du handler de succès (s'il y en a un). */
  success_handler?: ClientHandlerRef | null;
  /** Pour `client_call` : nom + position du handler d'échec. */
  failure_handler?: ClientHandlerRef | null;
  /** Pour `client_call` : texte de l'argument passé à withUserObject(). */
  user_object?: string | null;
  /** Pour `client_call` : textes des arguments serveur. */
  arguments_text?: string[];
  /** Pour `scriptlet` : type de scriptlet (`<? ?>`, `<?= ?>`, `<?!= ?>`). */
  scriptlet_kind?: ScriptletKindLabel;
}

export interface CallerInfo {
  file: string;
  line: number;
  caller: string;
  arguments_text: string[];
  return_used_as: string | null;
  /** Pour un caller cross-project, le nom du projet appelant. Absent = même projet. */
  caller_project?: string;
}

export interface PendingLibraryCall {
  library_prefix: string;
  method: string;
  caller_function: string;
  caller_file: string;
  caller_line: number;
  caller_arguments: string[];
  return_used_as: string | null;
}

export interface CrossProjectEdge {
  caller_project: string;
  caller_function: string;
  caller_file: string;
  caller_line: number;
  callee_project: string;
  callee_function: string;
  library_prefix: string;
}

export interface CoverageNote {
  what: string;
  where: string;
  reason: string;
  suggestion?: string;
}

export interface Coverage {
  resolved_pct: number;
  confidence: 'high' | 'medium' | 'low';
  unresolved: CoverageNote[];
  external_boundaries: string[];
}

export interface FieldRead {
  field: string;
  handler: string;
  file: string;
  line: number;
}

export interface InferredContract {
  /** Champs lus par les successHandler connus sur la valeur de retour. */
  return_shape: {
    fields_read: FieldRead[];
    field_names: string[];
    source: 'success_handler_consumption';
  } | null;
  /** Champs lus par les failureHandler connus sur l'objet erreur. */
  failure_signal: {
    fields_read: FieldRead[];
    field_names: string[];
  } | null;
  /** Handlers non analysés (inline, externes, lookup raté). */
  unresolved_handlers: Array<{
    kind: 'success' | 'failure';
    reason: string;
    where: string;
  }>;
}

export interface PositionRef {
  file: string;
  line: number;
}

export interface DestructuringContract {
  at: PositionRef;
  pattern: string;
  arity: number;
  /** Nom de la fonction bound (si valeur = `bare_identifier(...)`), sinon null. */
  bound_to: string | null;
}

export type PropertyStore =
  | 'script'
  | 'user'
  | 'document'
  | 'cache_script'
  | 'cache_user'
  | 'cache_document';

export interface PropertyKeyAccess {
  /** Clé littérale string ; null si l'argument n'est pas un string literal. */
  key: string | null;
  key_text: string;
  op: 'read' | 'write' | 'delete';
  store: PropertyStore;
  at: PositionRef;
}

export interface Array2dAccess {
  /** Nom de la variable qui porte le tableau 2D. */
  variable: string;
  /** Texte brut de l'expression source (ex: `sheet.getDataRange().getValues()`). */
  source: string;
  defined_at: PositionRef;
  /** Indices de colonne lus (uniques, triés). */
  column_indices_read: number[];
  /** max(column_indices_read). */
  max_index: number;
  /** Méthodes par lesquelles les lignes sont accédées (`map`, `forEach`…). */
  via: string[];
}

export interface TemplateBinding {
  /** Nom du fichier template tel que résolu (ex: `dashboard.html`). */
  template_file: string;
  template_var: string;
  assigned_at: PositionRef;
  data_fields_set: string[];
  data_fields_read_in_scriptlets: string[];
  /** Champs définis côté serveur mais jamais lus dans le template. */
  unread_data_fields: string[];
  /** Champs lus dans le template mais jamais définis côté serveur. */
  read_but_not_set: string[];
}

export interface FunctionPatterns {
  destructuring_contracts: DestructuringContract[];
  property_keys: PropertyKeyAccess[];
  array2d_access: Array2dAccess[];
  template_bindings: TemplateBinding[];
}

export interface FunctionRecord {
  id: string;
  name: string;
  project: string;
  definition: FunctionDefinition;
  exposures: Exposure[];
  calls_out: string[];
  called_by: CallerInfo[];
  inferred_contract: InferredContract | null;
  patterns: FunctionPatterns;
  return_analysis: ReturnAnalysis;
  coverage: Coverage;
}

export interface PropertyKeyEntry {
  key: string;
  store: PropertyStore;
  reads: Array<PositionRef & { function: string }>;
  writes: Array<PositionRef & { function: string }>;
  deletes: Array<PositionRef & { function: string }>;
  /** `write_only` = jamais lue ; `read_only` = jamais écrite ; `ok` sinon. */
  status: 'ok' | 'write_only' | 'read_only';
}

export interface ProjectCoverageSummary {
  resolved_pct: number;
  confidence: 'high' | 'medium' | 'low';
  total_unresolved: number;
  unresolved_by_kind: Record<string, number>;
  functions_with_open_returns: string[];
  functions_with_dynamic_dispatch: string[];
  functions_with_non_serializable_returns: string[];
}

export interface LibraryEntry {
  user_symbol: string;
  library_id: string;
  version: string;
  development_mode: boolean | null;
}

export interface AdvancedServiceEntry {
  user_symbol: string;
  service_id: string;
  version: string;
}

export interface ProjectManifest {
  runtime_version: string | null;
  oauth_scopes: string[];
  url_fetch_whitelist: string[];
  webapp: { execute_as: string | null; access: string | null } | null;
  libraries: LibraryEntry[];
  enabled_advanced_services: AdvancedServiceEntry[];
  /** False si aucun appsscript.json détecté (V3 §21.1 — distinct de « manifest vide »). */
  present: boolean;
}

export interface ReceiverUsage {
  /** Receiver d'un member_expression call (`GmailApp`, `Drive`, `OAuth2`, ...). */
  receiver: string;
  /** Méthode finale du call (`sendEmail`, `Files`, ...). */
  method: string;
  /** Fonction d'origine du call (caller). */
  function: string;
  file: string;
  line: number;
}

export interface ApiChainMethod {
  name: string;
  arity: number;
  arguments_text: string[];
  line: number;
  col: number;
}

export interface ApiCallChainRecord {
  root: string;
  methods: ApiChainMethod[];
  function: string;
  file: string;
  start_line: number;
  /** Vrai si la chaîne a un préfixe non résoluble (ex: namespace `Drive.Files`). */
  truncated_at_root: boolean;
}

export interface RuntimeSignalValueCallInLoop {
  function: string;
  file: string;
  method: string;
  loop_kind: string;
  line: number;
  col: number;
}

export interface RuntimeSignalFetchInLoop {
  function: string;
  file: string;
  loop_kind: string;
  line: number;
  col: number;
}

export interface RuntimeSignalLockAcquisition {
  function: string;
  file: string;
  method: 'waitLock' | 'tryLock';
  line: number;
  col: number;
  has_release_in_finally: boolean;
}

export interface RuntimeSignalTriggerCreate {
  function: string;
  file: string;
  line: number;
  col: number;
  handler_name: string | null;
}

export interface RuntimeSignals {
  value_calls_in_loops: RuntimeSignalValueCallInLoop[];
  fetches_in_loops: RuntimeSignalFetchInLoop[];
  lock_acquisitions: RuntimeSignalLockAcquisition[];
  trigger_creates: RuntimeSignalTriggerCreate[];
  /** Au moins un appel ScriptApp.deleteTrigger / deleteTrigger() ailleurs dans le projet. */
  has_any_delete_trigger: boolean;
}

export interface HtmlWebappMixedContentRef {
  tag: string;
  attr: string;
  url: string;
  line: number;
}

export interface HtmlWebappLinkWithoutTarget {
  href: string;
  line: number;
}

export interface HtmlWebappFormSubmitIssue {
  inline_handler: string | null;
  has_submit_control: boolean;
  line: number;
}

export interface HtmlWebappScriptHttpFetch {
  url: string;
  line: number;
}

export interface HtmlWebappFileSignals {
  file: string;
  has_base_target_top: boolean;
  mixed_content_refs: HtmlWebappMixedContentRef[];
  links_without_target: HtmlWebappLinkWithoutTarget[];
  forms_without_preventDefault: HtmlWebappFormSubmitIssue[];
  script_http_fetches: HtmlWebappScriptHttpFetch[];
}

export interface ProjectIndex {
  /** Discriminant pour les outils consommateurs (`workspace` ailleurs). */
  kind?: 'project';
  project: string;
  root: string;
  scanned_at: string;
  /** Durée du scan en ms (observabilité — `scan --bench` détaille). */
  scan_duration_ms?: number;
  /**
   * sha1 du contenu de chaque source (.gs/.html/appsscript.json), keyé par
   * chemin relatif à `root`. Fondations pour l'incremental scan (V3 §21).
   * Utilisable par d'autres outils pour détecter changements sans I/O.
   */
  file_hashes?: Record<string, string>;
  files: string[];
  functions: FunctionRecord[];
  /** Index des clés PropertiesService/CacheService au niveau projet. */
  property_keys: PropertyKeyEntry[];
  /** Appels `Lib.fn()` avec un préfixe déclaré en manifeste mais non encore résolus. */
  pending_library_calls: PendingLibraryCall[];
  /** Usage agrégé des receivers (services natifs, libs déclarées, et inconnus). */
  receiver_usage: ReceiverUsage[];
  /** Chaînes d'appels (Service.m1().m2()) à valider contre le registre GAS (V3 §21.2). */
  api_call_chains: ApiCallChainRecord[];
  /** Signaux pour lint-runtime (V3 §21.3) : boucles, locks, triggers. */
  runtime_signals: RuntimeSignals;
  /** Signaux côté HTML pour lint-webapp (V3 §21.4). */
  html_webapp_signals: HtmlWebappFileSignals[];
  /** Manifeste parsé — source pour `gaslens manifest` (V3 §21.1). */
  manifest: ProjectManifest;
  /** Synthèse coverage projet (V1 §1.5, V2 §10.4). */
  coverage_summary: ProjectCoverageSummary;
  unresolved_calls: UnresolvedCall[];
}

export interface WorkspaceIndex {
  kind: 'workspace';
  workspace_root: string;
  scanned_at: string;
  projects: ProjectIndex[];
  cross_project_edges: CrossProjectEdge[];
}

export interface UnresolvedCall {
  file: string;
  line: number;
  callee_text: string;
  reason: string;
}
