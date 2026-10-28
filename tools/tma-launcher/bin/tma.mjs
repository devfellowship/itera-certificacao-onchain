#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { main } from '../lib/launcher.mjs';

main(process.argv.slice(2)).then((code) => process.exit(code));
