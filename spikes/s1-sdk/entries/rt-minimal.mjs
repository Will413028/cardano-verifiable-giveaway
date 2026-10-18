import data from '../fixtures/vectors.json';
import * as opt from '../options/minimal.mjs';
import { run } from '../harness.mjs';
import { checkBuild } from '../build-check.mjs';

export async function runAll() { return { verify: await run(opt, data), build: null }; }
