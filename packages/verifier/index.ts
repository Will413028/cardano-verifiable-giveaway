import {
  validateBundle,
  validateProof,
  computeCommitment,
  roundTime,
  selectWinners,
  checkTiming,
  checkUniqueness,
  checkValidityBound,
  BOUNDARY,
  type Beacon,
  type Bundle,
  type CommitmentRef,
  type Confirmed,
  type Inclusion,
  type Network,
  type Proof,
} from '@giveaway/protocol';
import { FIXTURE, fetchBeacon, verifyBeacon } from '@giveaway/beacon';
import { type BundleChainReader, type ChainReader, DEMO_OWNER, DemoChain, demoTxHash } from '@giveaway/chain';
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
    // The indexer the caller selected. There is no default (B1, PD7): preprod evidence without one fails.
    chain?: ChainReader;
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
      const chain = options.chain;
      if (!chain) throw new Error('No indexer selected for preprod evidence');
      commitment = await chain.readCommitment(proof.txHash, proof.owner);
      // The history up to the referenced commitment's round: nothing included later can overlap it.
      candidates = await chain.findCommitments(proof.owner, commitment.round);
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
      checkValidityBound(commitment, proof.bundle.drand.round)
        ? 'The transaction validity upper bound (invalid_hereafter), inclusion and the 15th confirmation precede the round'
        : 'The transaction has no validity upper bound (invalid_hereafter) before the round, so the ledger does not rule out inclusion after it; the organizer must commit again with a later round',
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

// A proof assembled from a bundle, its commitment reference and the round's beacon: the winners are recomputed here,
// never taken from anyone. Shared by the page (opening a draw, a pending announcement after its round, a hosted bundle)
// and the CLI's bundle mode; verifyProof checks the result like any downloaded proof.
export async function assembleProof(
  network: Network,
  bundle: Bundle,
  ref: CommitmentRef,
  beacon: Beacon,
): Promise<Proof> {
  return {
    format: 'giveaway-proof-2',
    network,
    bundle,
    txHash: ref.txHash,
    owner: ref.owner,
    beacon,
    winners: await selectWinners(bundle, beacon.randomness),
  };
}
// The recorded fixture for its own round (no relay needed, as in the demo); every other round from the drand relays,
// each answer verified against the pinned key.
export const beaconFor = (round: number): Promise<Beacon> =>
  round === FIXTURE.round ? Promise.resolve(structuredClone(FIXTURE)) : fetchBeacon(round);
// The round of the bundle has not been produced yet: there is nothing to verify, only a commitment to wait on.
export class RoundNotReachedError extends Error {
  constructor(readonly round: number) {
    super(`Round ${round} has not been reached yet; the winners can be checked after ${roundTime(round)} (Unix time)`);
  }
}
export interface BundleOptions {
  // The indexer the caller selected; preprod evidence without one fails (B1, PD7).
  chain?: BundleChainReader;
  // Reads the round's verified beacon (default beaconFor).
  beacon?: (round: number) => Promise<Beacon>;
  // Unix seconds (default the current time), compared with the round time only.
  now?: number;
}
// Bundle mode (plan step 10, F9): a bundle and the hash of the transaction that committed it are enough. The demo
// reference is recognised by its derivation from the bundle hash (it binds nothing, docs/protocol-development.md);
// any other reference is a preprod transaction whose owner is read from the chain (BlockfrostChain.commitmentOwner).
// The beacon is fetched and the winners recomputed here; nothing else about the draw is taken from the artifact.
export async function bundleProof(value: unknown, txHash: string, options: BundleOptions = {}): Promise<Proof> {
  const bundle = validateBundle(value);
  if (!/^[a-f0-9]{64}$/.test(txHash)) throw new Error('Invalid commitment transaction hash');
  const round = bundle.drand.round;
  if ((options.now ?? Date.now() / 1000) < roundTime(round)) throw new RoundNotReachedError(round);
  const demo = txHash === (await demoTxHash(await computeCommitment(bundle)));
  let owner = DEMO_OWNER;
  if (!demo) {
    if (!options.chain) throw new Error('No indexer selected for preprod evidence');
    owner = await options.chain.commitmentOwner(txHash);
  }
  const beacon = await (options.beacon ?? beaconFor)(round);
  return assembleProof(demo ? 'demo' : 'preprod', bundle, { txHash, owner }, beacon);
}
export async function verifyBundle(value: unknown, txHash: string, options: BundleOptions = {}): Promise<Verdict> {
  return verifyProof(await bundleProof(value, txHash, options), { chain: options.chain });
}
