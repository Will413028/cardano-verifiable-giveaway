import {
  validateProof,
  computeCommitment,
  selectWinners,
  checkTiming,
  checkUniqueness,
  BOUNDARY,
  type Commitment,
  type Proof,
} from './index.ts';
import { verifyBeacon } from '../beacon/index.ts';
import { KoiosChain } from '../chain/index.ts';
export interface Check {
  name: string;
  passed: boolean;
  detail: string;
}
export interface Verdict {
  status: 'PASS' | 'DEMO PASS' | 'FAIL';
  checks: Check[];
  winners: string[];
  boundary: string;
}
export async function verifyProof(
  input: unknown,
  options: {
    now?: number;
    chain?: Pick<KoiosChain, 'readCommitment' | 'findCommitments'>;
  } = {},
): Promise<Verdict> {
  const checks: Check[] = [];
  const add = (name: string, passed: boolean, detail: string) => checks.push({ name, passed, detail });
  let proof: Proof;
  try {
    proof = validateProof(input);
    add('Bundle format', true, 'Development protocol; not frozen v1');
  } catch (e) {
    return {
      status: 'FAIL',
      checks: [{ name: 'Bundle format', passed: false, detail: (e as Error).message }],
      winners: [],
      boundary: BOUNDARY,
    };
  }
  let commitment = proof.commitment,
    candidates: Commitment[] = [commitment];
  try {
    if (proof.network === 'preprod') {
      const chain = options.chain ?? new KoiosChain();
      commitment = await chain.readCommitment(proof.commitment.txHash, proof.commitment.owner);
      candidates = await chain.findCommitments(proof.bundle.drawId, proof.commitment.owner);
      add('Cardano evidence', true, 'Read from selected preprod indexer; evidence still depends on that indexer');
    } else add('Demo evidence', true, 'Chain evidence is simulated. This is not proof of an on-chain commitment.');
  } catch (e) {
    add('Cardano evidence', false, (e as Error).message);
  }
  const hash = await computeCommitment(proof.bundle);
  add(
    'Commitment hash',
    hash === commitment.bundleHash &&
      proof.bundle.drawId === commitment.drawId &&
      proof.bundle.drand.round === commitment.round,
    'Bundle, drawId and drand round must match commitment',
  );
  add(
    'Timing and confirmations',
    checkTiming(commitment, proof.bundle.drand.round),
    'Inclusion and the 15th confirmation precede the round',
  );
  add(
    'Earliest commitment',
    checkUniqueness(candidates, commitment),
    'Earliest same-address, same-drawId commitment; simultaneous-block ambiguity fails closed',
  );
  add(
    'drand BLS signature',
    await verifyBeacon(proof.beacon, proof.bundle.drand.round),
    'Pinned quicknet public key; signature and randomness verified',
  );
  const { roundTime } = await import('./index.ts');
  add(
    'Round has arrived',
    (options.now ?? Math.floor(Date.now() / 1000)) >= roundTime(proof.bundle.drand.round),
    'Cannot open a future round',
  );
  let winners: string[] = [];
  if (checks.find((x) => x.name === 'drand BLS signature')?.passed)
    winners = await selectWinners(proof.bundle, proof.beacon.randomness);
  add(
    'Winner recomputation',
    JSON.stringify(winners) === JSON.stringify(proof.winners) && winners.length > 0,
    'Recomputed from signature-derived randomness and the committed bundle',
  );
  return {
    status: checks.every((x) => x.passed) ? (proof.network === 'demo' ? 'DEMO PASS' : 'PASS') : 'FAIL',
    checks,
    winners,
    boundary: BOUNDARY,
  };
}
