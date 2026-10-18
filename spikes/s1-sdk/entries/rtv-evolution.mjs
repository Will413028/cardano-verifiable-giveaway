// Verify-only entry for workerd: the backend never builds transactions.
import data from '../fixtures/vectors.json';
import * as opt from '../options/evolution.mjs';
import { run } from '../harness.mjs';
export async function runAll() { return { verify: await run(opt, data), build: null }; }
