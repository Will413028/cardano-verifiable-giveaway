import data from '../fixtures/vectors.json';
import * as opt from '../options/mesh.mjs';
import { run } from '../harness.mjs';
import { checkBuild } from '../build-check.mjs';
import * as builder from '../build/mesh.mjs';
export async function runAll() { return { verify: await run(opt, data), build: await checkBuild(builder, data.buildSpec) }; }
