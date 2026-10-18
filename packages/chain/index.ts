import {
  computeCommitment,
  CONFIRMATIONS,
  roundTime,
  VERSION,
  QUICKNET,
  type Bundle,
  type CommitmentRef,
  type Confirmed,
  type Inclusion,
  hex,
  sha256,
} from '@giveaway/protocol';
import {
  auxiliaryDataHash,
  auxiliaryMetadata,
  type CborValue,
  invalidHereafter,
  isCborArray,
  isCborMap,
  isValidTransaction,
  requiredSigners,
  setItems,
  transactionHash,
  transactionParts,
  verifiedSigners,
} from './cbor.ts';
export * from './cbor.ts';

// Private development label, absent from the CIP-10 registry (checked 2026-10-18 at CIPs commit befcdb7);
// registration is left to the v1 freeze.
export const LABEL = 20261018;
export const DEFAULT_INDEXER = 'https://preprod.koios.rest/api/v1';
export function commitmentMetadata(bundle: Bundle, bundleHash: string) {
  return { protocol: VERSION, drawId: bundle.drawId, bundleHash, chainHash: QUICKNET, round: bundle.drand.round };
}
// The commitment transaction moves this much from the organizer's address back to itself; the rest returns as change.
export const COMMITMENT_TRANSFER = 2_000_000n;
// The preprod slot clock, pinned rather than read from an indexer (PD5). Koios /genesis reports system start
// 1654041600 and Shelley slot length 1 s (read 2026-10-19); Byron ran 4 epochs of 21,600 slots of 20 s, so slot
// 86,400 began at 1655769600 and every later slot lasts one second. Checked against Koios tx_cbor for preprod
// transaction 3883c2a9 (absolute_slot 136605785, tx_timestamp 1792288985). Mainnet is not supported.
export const PREPROD_SLOTS = { zeroSlot: 86_400, zeroTime: 1_655_769_600, slotLength: 1 } as const;
export function preprodSlotTime(slot: bigint): number {
  if (slot < BigInt(PREPROD_SLOTS.zeroSlot) || slot > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('Slot is outside the pinned preprod slot clock');
  return PREPROD_SLOTS.zeroTime + (Number(slot) - PREPROD_SLOTS.zeroSlot) * PREPROD_SLOTS.slotLength;
}
export function preprodSlotAt(time: number): bigint {
  if (!Number.isSafeInteger(time) || time < PREPROD_SLOTS.zeroTime)
    throw new Error('Time is outside the pinned preprod slot clock');
  return BigInt(PREPROD_SLOTS.zeroSlot + Math.floor((time - PREPROD_SLOTS.zeroTime) / PREPROD_SLOTS.slotLength));
}
// Preprod's expected block interval: slot length 1 s over active slot coefficient 0.05 (Koios /genesis).
const EXPECTED_BLOCK_SECONDS = 20;
// The validity upper bound the page sets: early enough that the 15 confirmations the verifier requires can be
// expected before the round. The protocol itself only requires the bound to precede the round.
export function commitmentValidUntil(round: number): number {
  return roundTime(round) - CONFIRMATIONS * EXPECTED_BLOCK_SECONDS;
}
// What the page asked the transaction SDK to build. The unsigned CBOR is re-read with the trust-path reader and
// compared against this before the wallet is asked to sign, so an SDK that builds something else is never signed.
export interface CommitmentPlan {
  input: { txHash: string; index: number; lovelace: bigint };
  // Hex bytes of the organizer address: it receives both the transfer and the change.
  address: string;
  metadata: ReturnType<typeof commitmentMetadata>;
  // The organizer identity key hash (hex) that must be the only required signer (PD3).
  signer: string;
  // The invalid_hereafter slot, whose time precedes the round (PD5).
  invalidHereafter: bigint;
}
// inputs, outputs, fee, invalid_hereafter, auxiliary data hash, required_signers: anything else (mint, withdrawals,
// certificates, collateral, validity start...) is refused.
const COMMITMENT_BODY_FIELDS = new Set<unknown>([0, 1, 2, 3, 7, 14]);
function adaOutput(output: CborValue): { address: string; lovelace: bigint } {
  const [address, amount, extra] = isCborMap(output)
    ? [output.get(0), output.get(1), [...output.keys()].some((k) => k !== 0 && k !== 1)]
    : isCborArray(output)
      ? [output[0], output[1], output.length !== 2]
      : [undefined, undefined, true];
  if (!(address instanceof Uint8Array) || typeof amount !== 'bigint' || extra)
    throw new Error('Unsigned transaction has an output that is not plain ADA');
  return { address: hex(address), lovelace: amount };
}
function sameMetadatum(value: CborValue, expected: unknown): boolean {
  if (typeof expected === 'string') return value === expected;
  if (typeof expected === 'number') return typeof value === 'bigint' && value === BigInt(expected);
  if (typeof expected !== 'object' || expected === null || !isCborMap(value)) return false;
  const entries = Object.entries(expected);
  return value.size === entries.length && entries.every(([k, v]) => value.has(k) && sameMetadatum(value.get(k), v));
}
export function checkCommitmentTransaction(txHex: string, plan: CommitmentPlan): { fee: bigint; txHash: string } {
  const { transaction, body, auxiliary } = transactionParts(txHex);
  if (transaction.length !== 4 || transaction[2] !== true)
    throw new Error('Unsigned transaction is not a Conway transaction');
  const witnesses = transaction[1];
  if (!isCborMap(witnesses) || witnesses.size) throw new Error('Unsigned transaction already carries witnesses');
  for (const key of body.keys())
    if (!COMMITMENT_BODY_FIELDS.has(key))
      throw new Error(`Unsigned transaction has unexpected body field ${String(key)}`);
  const inputs = setItems(body.get(0));
  const input = inputs?.length === 1 ? inputs[0] : undefined;
  if (
    !isCborArray(input) ||
    !(input[0] instanceof Uint8Array) ||
    hex(input[0]) !== plan.input.txHash ||
    input[1] !== BigInt(plan.input.index)
  )
    throw new Error('Unsigned transaction spends an unexpected input');
  const outputs = body.get(1);
  if (!isCborArray(outputs) || outputs.length !== 2)
    throw new Error('Unsigned transaction must have a transfer and a change output');
  const [transfer, change] = outputs.map(adaOutput);
  const address = plan.address.toLowerCase();
  if (transfer.address !== address || transfer.lovelace !== COMMITMENT_TRANSFER)
    throw new Error('Unsigned transaction transfer output differs from the commitment');
  if (change.address !== address) throw new Error('Unsigned transaction sends change to another address');
  const fee = body.get(2);
  if (typeof fee !== 'bigint' || transfer.lovelace + change.lovelace + fee !== plan.input.lovelace)
    throw new Error('Unsigned transaction does not balance its input');
  const auxHash = auxiliaryDataHash(txHex);
  if (auxHash.computed === null || auxHash.computed !== auxHash.declared)
    throw new Error('Unsigned transaction auxiliary data hash mismatch');
  const metadata = auxiliary ? auxiliaryMetadata(auxiliary) : null;
  if (metadata?.size !== 1 || !sameMetadatum(metadata.get(LABEL), plan.metadata))
    throw new Error('Unsigned transaction metadata differs from the commitment');
  const signers = requiredSigners(body);
  if (signers.length !== 1 || signers[0] !== plan.signer.toLowerCase())
    throw new Error('Unsigned transaction required signers differ from the organizer identity');
  if (invalidHereafter(body) !== plan.invalidHereafter)
    throw new Error('Unsigned transaction validity upper bound differs from the commitment');
  return { fee, txHash: transactionHash(txHex) };
}
export const DEMO_OWNER = 'demo-organizer';
// Demo evidence is simulated from the bundle alone, so a fresh page or the CLI can re-derive it; the
// transaction hash binds the bundle hash so a changed bundle no longer matches its demo reference.
export async function demoInclusion(bundle: Bundle): Promise<Inclusion> {
  const bundleHash = await computeCommitment(bundle);
  return {
    txHash: await sha256(`giveaway-demo-commitment:${bundleHash}`),
    owner: DEMO_OWNER,
    bundleHash,
    drawId: bundle.drawId,
    round: bundle.drand.round,
    blockHeight: 1000,
    blockTime: roundTime(bundle.drand.round) - 900,
  };
}
export class DemoChain {
  readonly network = 'demo';
  private readonly included = new Map<string, Inclusion>();
  async commit(bundle: Bundle): Promise<CommitmentRef> {
    const inclusion = await demoInclusion(bundle);
    this.included.set(inclusion.txHash, inclusion);
    return { txHash: inclusion.txHash, owner: inclusion.owner };
  }
  confirm(ref: CommitmentRef, late = false): Confirmed {
    const inclusion = this.included.get(ref.txHash);
    if (!inclusion) throw new Error('Unknown demo commitment');
    return {
      ...inclusion,
      confirmedAt: roundTime(inclusion.round) + (late ? 1 : -300),
      validUntil: demoValidUntil(inclusion),
    };
  }
  // The verifier's view of a demo draw: always confirmed on time, because there is no chain to ask.
  async readCommitment(bundle: Bundle): Promise<Confirmed> {
    const inclusion = await demoInclusion(bundle);
    return { ...inclusion, confirmedAt: roundTime(inclusion.round) - 300, validUntil: demoValidUntil(inclusion) };
  }
}
// A simulated validity upper bound, as the page sets it on preprod.
const demoValidUntil = (inclusion: Inclusion) => commitmentValidUntil(inclusion.round);
const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(values: number[]): number {
  const generator = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= generator[i];
  }
  return chk >>> 0;
}
const expand = (hrp: string) => [
  ...[...hrp].map((c) => c.charCodeAt(0) >> 5),
  0,
  ...[...hrp].map((c) => c.charCodeAt(0) & 31),
];
function regroup(data: number[], from: number, to: number, pad: boolean): number[] {
  let acc = 0,
    bits = 0;
  const out: number[] = [];
  for (const v of data) {
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & ((1 << to) - 1));
    }
  }
  if (pad && bits) out.push((acc << (to - bits)) & ((1 << to) - 1));
  else if (!pad && (bits >= from || (acc << (to - bits)) & ((1 << to) - 1))) throw new Error('Invalid bech32 padding');
  return out;
}
// BIP-173 bech32 without the 90-character limit, as Cardano addresses use it (CIP-19).
export function decodeBech32(text: string): { prefix: string; bytes: Uint8Array } {
  if (text !== text.toLowerCase()) throw new Error('Invalid bech32 case');
  const at = text.lastIndexOf('1');
  if (at < 1 || text.length - at < 7) throw new Error('Invalid bech32 string');
  const prefix = text.slice(0, at);
  const words = [...text.slice(at + 1)].map((c) => BECH32.indexOf(c));
  if (words.some((w) => w < 0)) throw new Error('Invalid bech32 character');
  if (polymod([...expand(prefix), ...words]) !== 1) throw new Error('Invalid bech32 checksum');
  return { prefix, bytes: Uint8Array.from(regroup(words.slice(0, -6), 5, 8, false)) };
}
export function encodeBech32(prefix: string, bytes: Uint8Array): string {
  const words = regroup([...bytes], 8, 5, true);
  const chk = polymod([...expand(prefix), ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (chk >>> (5 * (5 - i))) & 31);
  return `${prefix}1${[...words, ...checksum].map((w) => BECH32[w]).join('')}`;
}
// The uniqueness identity of an organizer address (PD3): its stake credential when the address has one,
// otherwise its payment credential. Only key credentials are supported; `key` is what the indexer
// enumerates by and what a proxy cache is keyed on.
export type Identity = { kind: 'stake'; key: string } | { kind: 'payment'; key: string };
export function identityOf(owner: string): Identity {
  const { prefix, bytes } = decodeBech32(owner);
  const type = bytes[0] >> 4;
  if (prefix !== 'addr_test' || (bytes[0] & 15) !== 0) throw new Error('Organizer address is not a preprod address');
  if (type === 0 && bytes.length === 57)
    return { kind: 'stake', key: encodeBech32('stake_test', Uint8Array.from([0xe0, ...bytes.slice(29)])) };
  if (type === 6 && bytes.length === 29) return { kind: 'payment', key: hex(bytes.slice(1)) };
  throw new Error('Organizer address must be a key-hash base or enterprise address');
}
// The key hash (hex) of the organizer identity: the stake key of a base address, else the payment key (PD3).
export function identityKeyHash(owner: string): string {
  const identity = identityOf(owner);
  const { bytes } = decodeBech32(owner);
  return identity.kind === 'stake' ? hex(bytes.slice(29)) : hex(bytes.slice(1));
}
export interface CommitmentMetadata {
  bundleHash: string;
  drawId: string;
  round: number;
}
// What one raw transaction says about a commitment, every field read from CBOR whose hash was checked here.
export interface CommitmentTransaction {
  // The development commitment under LABEL; null when the label is absent or carries another protocol version.
  metadata: CommitmentMetadata | null;
  // The label carries this protocol version in a shape that is not a commitment. Kept apart from `metadata` so a
  // malformed entry in someone else's transaction cannot fail the organizer's history before signers are checked.
  malformed: boolean;
  // Required signers whose vkey witness verifies over the transaction id.
  signers: Set<string>;
  // False for a phase-2 failed transaction (is_valid = false), which the ledger records but does not apply.
  valid: boolean;
  // The invalid_hereafter slot, or null when the transaction sets none.
  invalidHereafter: bigint | null;
}
// The LABEL entry as a commitment: null when absent or another protocol version, 'malformed' when it claims
// this version without valid commitment fields (the same field rules the indexer JSON was held to before).
function commitmentEntry(auxiliary: Uint8Array | null): CommitmentMetadata | null | 'malformed' {
  let entry: CborValue;
  try {
    entry = auxiliary ? auxiliaryMetadata(auxiliary)?.get(LABEL) : undefined;
  } catch {
    return null;
  }
  if (!isCborMap(entry) || entry.get('protocol') !== VERSION) return null;
  const [drawId, bundleHash, chainHash, round] = ['drawId', 'bundleHash', 'chainHash', 'round'].map((k) =>
    entry.get(k),
  );
  if (
    chainHash !== QUICKNET ||
    typeof bundleHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(bundleHash) ||
    typeof drawId !== 'string' ||
    typeof round !== 'bigint' ||
    round < 0n ||
    round > BigInt(Number.MAX_SAFE_INTEGER)
  )
    return 'malformed';
  return { bundleHash, drawId, round: Number(round) };
}
// Reads a commitment from the indexer's raw transaction bytes (F2): the body must hash to the transaction id
// and the auxiliary data to the body's declared hash, so the indexer can neither substitute the body nor the
// metadata. The block it reports the transaction in is not covered and remains indexer evidence.
export function readCommitmentTransaction(txHex: string, txHash: string): CommitmentTransaction {
  const parts = transactionParts(txHex);
  if (transactionHash(txHex) !== txHash) throw new Error('Transaction CBOR does not match its hash');
  const auxHash = auxiliaryDataHash(txHex);
  if (auxHash.computed !== auxHash.declared) throw new Error('Transaction auxiliary data hash mismatch');
  const entry = commitmentEntry(parts.auxiliary);
  return {
    metadata: entry === 'malformed' ? null : entry,
    malformed: entry === 'malformed',
    signers: verifiedSigners(parts),
    valid: isValidTransaction(parts),
    invalidHereafter: invalidHereafter(parts.body),
  };
}
// The indexer has no such transaction: before its invalid_hereafter it may still be included, after it never.
export class NotIndexedError extends Error {
  constructor() {
    super('Transaction is not indexed yet');
  }
}
// The indexer lists the transaction but has not served its bytes: it may already be on chain, so this is never
// evidence that the transaction expired; only NotIndexedError (no record at all) is.
export class CborPendingError extends Error {
  constructor() {
    super('The indexer lists the transaction but has not served its CBOR yet');
  }
}
// biome-ignore lint/suspicious/noExplicitAny: Koios rows are untyped JSON; only inclusion, enumeration and inputs are read from them.
type Row = Record<string, any>;
export class KoiosChain {
  constructor(readonly base = DEFAULT_INDEXER) {
    const url = new URL(base);
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new Error('Indexer must be an HTTPS URL without credentials');
  }
  async query(endpoint: string, body?: object): Promise<Row[]> {
    const response = await fetch(`${this.base.replace(/\/$/, '')}/${endpoint}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`Indexer ${endpoint}: HTTP ${response.status}`);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('Unexpected indexer response');
    return rows;
  }
  async readCommitment(txHash: string, owner: string): Promise<Confirmed> {
    if (!/^[a-f0-9]{64}$/.test(txHash) || !/^addr_test1[a-z0-9]+$/.test(owner))
      throw new Error('Invalid preprod commitment reference');
    const identity = identityKeyHash(owner);
    const rows = await this.query('tx_cbor', { _tx_hashes: [txHash] });
    const row = rows.find((x) => x.tx_hash === txHash);
    if (!row) throw new NotIndexedError();
    if (typeof row.cbor !== 'string') throw new CborPendingError();
    const tx = readCommitmentTransaction(row.cbor, txHash);
    if (!tx.valid) throw new Error('Invalid transaction');
    if (!tx.signers.has(identity))
      throw new Error(
        'Organizer identity key did not sign the commitment (required signer witness missing or invalid)',
      );
    // The CBOR holds only input references; which address an input spends from is the indexer's report.
    const info = await this.query('tx_info', { _tx_hashes: [txHash], _inputs: true });
    if (!info.find((x) => x.tx_hash === txHash)?.inputs?.some((x: Row) => x.payment_addr?.bech32 === owner))
      throw new Error('Organizer address is not a transaction input');
    const inclusion = this.inclusionFrom(txHash, owner, row, tx);
    const height = inclusion.blockHeight + CONFIRMATIONS - 1;
    const blocks = await this.query(`blocks?block_height=eq.${height}&limit=1`);
    const block = blocks.find((x) => x.block_height === height);
    if (!block) throw new Error(`Waiting for ${CONFIRMATIONS} confirmations`);
    if (!Number.isSafeInteger(block.block_time)) throw new Error('Invalid confirmation block time');
    const slot = tx.invalidHereafter;
    return { ...inclusion, confirmedAt: block.block_time, validUntil: slot === null ? null : preprodSlotTime(slot) };
  }
  // `row` is the indexer's tx_cbor row: its block height and time are indexer evidence; `tx` was read from CBOR.
  private inclusionFrom(txHash: string, owner: string, row: Row, tx: CommitmentTransaction): Inclusion {
    const m = tx.metadata;
    if (!m) throw new Error('Unsupported commitment metadata');
    if (!Number.isSafeInteger(row.block_height) || !Number.isSafeInteger(row.tx_timestamp))
      throw new Error('Invalid inclusion block');
    return {
      txHash,
      owner,
      bundleHash: m.bundleHash,
      drawId: m.drawId,
      round: m.round,
      blockHeight: row.block_height,
      blockTime: row.tx_timestamp,
    };
  }
  // Every commitment of the owner's identity, whatever its drawId or round; uniqueness compares their intervals.
  async findCommitments(owner: string): Promise<Inclusion[]> {
    if (!/^addr_test1[a-z0-9]+$/.test(owner)) throw new Error('Invalid organizer address');
    const identity = identityOf(owner);
    const signer = identityKeyHash(owner);
    const hashes: string[] = [];
    const pageSize = 1000;
    // Ordered by height then hash so pages do not shift between requests within one block.
    const order = `limit=${pageSize}&order=block_height.asc,tx_hash.asc`;
    for (let offset = 0; ; offset += pageSize) {
      const page =
        identity.kind === 'stake'
          ? await this.query(`account_txs?_stake_address=${identity.key}&${order}&offset=${offset}`)
          : await this.query(`credential_txs?${order}&offset=${offset}`, { _payment_credentials: [identity.key] });
      for (const x of page) {
        if (!/^[a-f0-9]{64}$/.test(x.tx_hash)) throw new Error('Invalid transaction list');
        hashes.push(x.tx_hash);
      }
      if (page.length < pageSize) break;
      if (offset + pageSize >= 5000)
        throw new Error('Organizer history exceeds development query limit; uniqueness cannot be established');
    }
    const found: Inclusion[] = [];
    // Koios public tier rejects request bodies over 5 KiB with HTTP 413 (75 hashes passed, 76 failed; measured on
    // preprod 2026-10-19), so batches of 50 hashes leave room.
    const batch = 50;
    for (let i = 0; i < hashes.length; i += batch) {
      // The indexer's metadata JSON only selects which transactions to read as CBOR: hiding a commitment here is
      // no different from leaving it out of the enumeration, and everything counted is read from checked CBOR.
      const rows = await this.query('tx_metadata', { _tx_hashes: hashes.slice(i, i + batch) });
      const matching = rows.filter((row) => row.metadata?.[LABEL]?.protocol === VERSION).map((row) => row.tx_hash);
      if (!matching.length) continue;
      const transactions = await this.query('tx_cbor', { _tx_hashes: matching });
      for (const txHash of matching) {
        const row = transactions.find((x) => x.tx_hash === txHash);
        if (!row || typeof row.cbor !== 'string')
          throw new Error('Organizer history transaction evidence is incomplete');
        const tx = readCommitmentTransaction(row.cbor, txHash);
        // Only the identity key's verified signature makes a transaction this identity's commitment (PD3): a
        // third party can put the organizer's stake part in its own address but cannot sign with its key.
        // Which address the inputs spend from is not consulted, so the same wallet committing from another
        // payment address is still counted.
        // A malformed entry in the identity's own signed transaction still fails the history (inclusionFrom).
        if (!tx.valid || !tx.signers.has(signer) || (!tx.metadata && !tx.malformed)) continue;
        found.push(this.inclusionFrom(txHash, owner, row, tx));
      }
    }
    return found;
  }
}
