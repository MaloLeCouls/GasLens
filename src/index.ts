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
export { runDoctor } from './doctor.js';
export type { DoctorReport, DoctorCheck } from './doctor.js';
export { buildWorkspaceFiles, writeWorkspace } from './workspace-init.js';
export type { WorkspaceInitOptions } from './workspace-init.js';
export { planAddApp, runAddApp } from './workspace-add-app.js';
export type { AddAppOptions } from './workspace-add-app.js';
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
