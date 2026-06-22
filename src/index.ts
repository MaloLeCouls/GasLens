export { scanProject, scanWorkspace } from './scanner.js';
export {
  loadWorkspaceManifest,
  parseWorkspaceManifest,
  WORKSPACE_MANIFEST_FILENAME,
} from './workspace-manifest.js';
export type {
  WorkspaceManifest,
  App as WorkspaceApp,
  Library as WorkspaceLibrary,
} from './workspace-manifest.js';
export { runEnvValidate } from './env-validate.js';
export type { EnvValidateReport } from './env-validate.js';
export { lintDoc, docStub } from './doc-lint.js';
export type { DocLintReport } from './doc-lint.js';
export type {
  ProjectIndex,
  WorkspaceIndex,
  FunctionRecord,
  FunctionDefinition,
  Exposure,
  CallerInfo,
  Coverage,
  CrossProjectEdge,
  PendingLibraryCall,
  Param,
  ReturnDoc,
  UnresolvedCall,
} from './types.js';
