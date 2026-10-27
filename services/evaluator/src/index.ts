// Public surface of the evaluator for the runner and the API.
export { DEFAULT_INSTALL, EVALUATOR_VERSION, canonicalDigest, runEvaluation, workspaceRelative, type RunEvaluationOptions } from './runner.js';
export { interpretRun, localExecutor, resolveCmd, type SuiteExecutor, type SuiteRunRequest, type SuiteRunResult } from './suite.js';
export { BUNDLE_FOLDER } from './pack-folders.js';
export { addTests, hashDirectory, loadTask, materializeWorkspace, readInstruction, scenarioDir, taskDigests, TaskError, type LoadedTask, type TaskContract } from './task.js';
export { validateTask, type ValidationResult } from './validate.js';
export { checkPatchScope, DEFAULT_SCOPE, type ScopeRules } from './patch-scope.js';
export type * from './types.js';
