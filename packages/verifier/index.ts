import {
  validateProof,
  computeCommitment,
  selectWinners,
  checkTiming,
  checkUniqueness,
  BOUNDARY,
  type Confirmed,
  type Inclusion,
  type Proof,
} from '@giveaway/protocol';
import { verifyBeacon } from '@giveaway/beacon';
import { DemoChain, KoiosChain } from '@giveaway/chain';
// A check whose evidence could not be obtained is not evaluated, never passed on the artifact's own word.
export type CheckResult = 'pass' | 'fail' | 'unevaluated';
export interface Check {
  name: string;
  result: CheckResult;
  detail: string;
}
// A commitment by the same identity whose interval overlaps the verified one.
export interface Conflict {
  txHash: string;
  drawId: string;
  round: number;
  blockHeight: number;
  blockTime: number;
}
export interface Verdict {
  status: 'PASS' | 'DEMO PASS' | 'FAIL';
  checks: Check[];
  conflicts: Conflict[];
  winners: string[];
  boundary: string;
}
export const UNIQUENESS_CHECK = 'Unique commitment';
const result = (passed: boolean): CheckResult => (passed ? 'pass' : 'fail');
export async function verifyProof(
  input: unknown,
  options: {
    chain?: Pick<KoiosChain, 'readCommitment' | 'findCommitments'>;
  } = {},
): Promise<Verdict> {
  const checks: Check[] = [];
  const add = (name: string, outcome: CheckResult, detail: string) => checks.push({ name, result: outcome, detail });
  let proof: Proof;
  try {
    proof = validateProof(input);
    add('Bundle format', 'pass', 'Development protocol; not frozen v1');
  } catch (e) {
    return {
      status: 'FAIL',
      checks: [{ name: 'Bundle format', result: 'fail', detail: (e as Error).message }],
      conflicts: [],
      winners: [],
      boundary: BOUNDARY,
    };
  }
  let commitment: Confirmed | undefined, candidates: Inclusion[] | undefined;
  try {
    if (proof.network === 'preprod') {
      const chain = options.chain ?? new KoiosChain();
      commitment = await chain.readCommitment(proof.txHash, proof.owner);
      candidates = await chain.findCommitments(proof.owner);
      add('Cardano evidence', 'pass', 'Read from selected preprod indexer; evidence still depends on that indexer');
    } else {
      commitment = await new DemoChain().readCommitment(proof.bundle);
      candidates = [commitment];
      add('Demo evidence', 'pass', 'Chain evidence is simulated. This is not proof of an on-chain commitment.');
    }
  } catch (e) {
    add('Cardano evidence', 'fail', (e as Error).message);
  }
  const unevaluated = 'Not evaluated: chain evidence is unavailable';
  let conflicts: Conflict[] = [];
  if (commitment && candidates) {
    const hash = await computeCommitment(proof.bundle);
    add(
      'Commitment hash',
      result(
        commitment.txHash === proof.txHash &&
          commitment.owner === proof.owner &&
          hash === commitment.bundleHash &&
          proof.bundle.drawId === commitment.drawId &&
          proof.bundle.drand.round === commitment.round,
      ),
      'Bundle, drawId and drand round must match the referenced commitment',
    );
    add(
      'Timing and confirmations',
      result(checkTiming(commitment, proof.bundle.drand.round)),
      'Inclusion and the 15th confirmation precede the round',
    );
    const uniqueness = checkUniqueness(candidates, commitment);
    conflicts = uniqueness.conflicts.map(({ txHash, drawId, round, blockHeight, blockTime }) => ({
      txHash,
      drawId,
      round,
      blockHeight,
      blockTime,
    }));
    add(
      UNIQUENESS_CHECK,
      result(uniqueness.passed),
      conflicts.length
        ? `Overlapping commitments by the same organizer: ${conflicts.map((x) => x.txHash).join(', ')}`
        : uniqueness.passed
          ? 'No other commitment by the same organizer is open between this inclusion and the round'
          : 'The referenced commitment is missing from the organizer history; uniqueness cannot be established',
    );
  } else
    for (const name of ['Commitment hash', 'Timing and confirmations', UNIQUENESS_CHECK])
      add(name, 'unevaluated', unevaluated);
  // A valid signature for the committed round proves the round has been produced; no local clock is consulted.
  const beaconValid = await verifyBeacon(proof.beacon, proof.bundle.drand.round);
  add('drand BLS signature', result(beaconValid), 'Pinned quicknet public key; signature and randomness verified');
  let winners: string[] = [];
  if (beaconValid) {
    winners = await selectWinners(proof.bundle, proof.beacon.randomness);
    add(
      'Winner recomputation',
      result(JSON.stringify(winners) === JSON.stringify(proof.winners) && winners.length > 0),
      'Recomputed from signature-derived randomness and the committed bundle',
    );
  } else add('Winner recomputation', 'unevaluated', 'Not evaluated: no verified randomness');
  return {
    status: checks.every((x) => x.result === 'pass') ? (proof.network === 'demo' ? 'DEMO PASS' : 'PASS') : 'FAIL',
    checks,
    conflicts,
    winners,
    boundary: BOUNDARY,
  };
}
