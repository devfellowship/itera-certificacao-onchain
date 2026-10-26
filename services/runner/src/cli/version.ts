// The version of the `tma` CLI: the runner package version (services/runner/package.json). It is the
// `runner.version` of a converted result and the version in the login client name.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CLI_VERSION: string = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf-8')).version;
