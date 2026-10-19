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
  withdrawals,
} from './cbor.ts';
export * from './cbor.ts';

// Private development label, absent from the CIP-10 registry (checked 2026-10-18 at CIPs commit befcdb7);
// registration is left to the v1 freeze.
export const LABEL = 20261018;
export function commitmentMetadata(bundle: Bundle, bundleHash: string) {
  return { protocol: VERSION, drawId: bundle.drawId, bundleHash, chainHash: QUICKNET, round: bundle.drand.round };
}
// The commitment transaction moves this much from the organizer's address back to itself; the rest returns as change.
export const COMMITMENT_TRANSFER = 2_000_000n;
// The preprod slot clock, pinned rather than read from an indexer (PD5). The preprod genesis reports system start
// 1654041600 and Shelley slot length 1 s (read from a public indexer's /genesis on 2026-10-19); Byron ran 4 epochs of
// 21,600 slots of 20 s, so slot 86,400 began at 1655769600 and every later slot lasts one second. Checked against the
// slot and time an indexer reported for preprod transaction 3883c2a9 (slot 136605785, time 1792288985). Mainnet is
// not supported.
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
// Preprod's expected block interval: slot length 1 s over active slot coefficient 0.05 (preprod genesis).
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
  // The reward withdrawal every commitment carries (PD10): the organizer reward account (hex) and its whole balance,
  // which the ledger requires (0 when the balance is 0).
  withdrawal: { account: string; lovelace: bigint };
}
// inputs, outputs, fee, invalid_hereafter, withdrawals, auxiliary data hash, required_signers: anything else (mint,
// certificates, collateral, validity start...) is refused. Stake registration and DRep delegation cannot share the
// commitment transaction: the ledger checks the withdrawal against the state before it (spike-withdrawal.md).
const COMMITMENT_BODY_FIELDS = new Set<unknown>([0, 1, 2, 3, 5, 7, 14]);
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
  const withdrawn = withdrawals(body);
  if (withdrawn.size !== 1 || withdrawn.get(plan.withdrawal.account.toLowerCase()) !== plan.withdrawal.lovelace)
    throw new Error('Unsigned transaction withdrawal differs from the organizer reward account balance');
  const fee = body.get(2);
  if (
    typeof fee !== 'bigint' ||
    transfer.lovelace + change.lovelace + fee !== plan.input.lovelace + plan.withdrawal.lovelace
  )
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
// The uniqueness identity of an organizer address (PD3, PD10): the stake credential of a key-hash base address. The
// history is the reward account's withdrawals, which only the stake key can add, so an address without a stake key
// (enterprise) has no identity here and is refused. `key` is the stake address the indexer enumerates by and what
// any enumeration cache would be keyed on (B6).
export type Identity = { kind: 'stake'; key: string };
export function identityOf(owner: string): Identity {
  const { prefix, bytes } = decodeBech32(owner);
  const type = bytes[0] >> 4;
  if (prefix !== 'addr_test' || (bytes[0] & 15) !== 0) throw new Error('Organizer address is not a preprod address');
  if (type === 6)
    throw new Error(
      'Organizer address must be a base address with a stake key: an enterprise address has no reward account, and uniqueness is read from the stake reward account withdrawals (PD10)',
    );
  if (type === 0 && bytes.length === 57)
    return { kind: 'stake', key: encodeBech32('stake_test', Uint8Array.from([0xe0, ...bytes.slice(29)])) };
  throw new Error('Organizer address must be a key-hash base address');
}
// The key hash (hex) of the organizer identity: the stake key of the base address (PD3).
export function identityKeyHash(owner: string): string {
  identityOf(owner);
  return hex(decodeBech32(owner).bytes.slice(29));
}
// The organizer reward account (hex, CIP-19 header e0: testnet key-hash stake address) every commitment withdraws
// from (PD10).
export function identityRewardAccount(owner: string): string {
  return hex(decodeBech32(identityOf(owner).key).bytes);
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
  // Reward accounts (hex) the transaction withdraws from (body field 5).
  withdrawals: Set<string>;
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
    withdrawals: new Set(withdrawals(parts.body).keys()),
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
// The uniqueness enumeration limit L (plan steps 8b, 9b; docs/protocol-development.md "Uniqueness"): the rows of the
// organizer reward account's withdrawal list read before the round, counted here rather than left to the node's
// max_scan_items. Only the stake key can add a row (a withdrawal needs its witness on the ledger), so a history over L
// is the organizer's own doing and fails verification. 2,900 is the largest multiple of the page size whose
// end-detecting page (page 30 of 100) stays within the Dolos default max_scan_items of 3,000, so a default node serves
// every history accepted here.
export const HISTORY_ROW_LIMIT = 2_900;
// Blockfrost's maximum page size; Dolos refuses count > 100 with HTTP 400.
const PAGE = 100;
const historyTooLarge = () =>
  new Error(
    `Organizer history exceeds ${HISTORY_ROW_LIMIT} withdrawal rows before the round; uniqueness cannot be established. Only the organizer stake key can add these rows: this is the organizer's own commitment history`,
  );
// A non-2xx answer. The status decides (any of them fails the read); the body only picks the message.
export class IndexerError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    body: string,
  ) {
    let message: unknown;
    try {
      message = JSON.parse(body)?.message;
    } catch {}
    super(
      status === 404 && body === ''
        ? `Indexer ${path}: HTTP 404 without a body (unknown item, or the node lacks this endpoint)`
        : `Indexer ${path}: HTTP ${status}${typeof message === 'string' ? ` (${message})` : ''}${
            status === 400 && typeof message === 'string' && message.includes('scan limit')
              ? '; the node max_scan_items is too low for this history'
              : ''
          }`,
    );
  }
}
// Only hosts on this machine may use plain http (a node the verifier runs itself).
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
export function indexerUrl(value: string): string {
  const url = new URL(value);
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
  if (!secure || url.username || url.password || url.search || url.hash)
    throw new Error('Indexer must be an https URL (http only on this machine) without credentials, query or fragment');
  return url.href.replace(/\/$/, '');
}
export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;
// biome-ignore lint/suspicious/noExplicitAny: indexer rows are untyped JSON; each field read is checked where it is used.
type Row = Record<string, any>;
const isTxHash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const BECH32_ADDRESS = /^addr_test1[a-z0-9]+$/;
// What the verifier needs from an indexer: the referenced commitment and every commitment of its identity.
export type ChainReader = Pick<BlockfrostChain, 'readCommitment' | 'findCommitments'>;
// Reads a Blockfrost-shaped indexer (Dolos MiniBF, Blockfrost RYO). There is no default: the caller names the node.
export class BlockfrostChain {
  readonly base: string;
  constructor(
    base: string,
    private readonly fetcher: Fetcher = (input, init) => fetch(input, init),
  ) {
    this.base = indexerUrl(base);
  }
  private async get(path: string): Promise<{ status: number; body: string }> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.base}${path}`, { signal: AbortSignal.timeout(20000) });
    } catch (e) {
      throw new Error(`Indexer ${path}: unreachable (${(e as Error).message})`);
    }
    return { status: response.status, body: await response.text() };
  }
  // A 2xx JSON answer, or an IndexerError.
  private async json(path: string, answer?: { status: number; body: string }): Promise<Row> {
    const { status, body } = answer ?? (await this.get(path));
    if (status < 200 || status > 299) throw new IndexerError(path, status, body);
    try {
      return JSON.parse(body);
    } catch {
      throw new Error(`Indexer ${path}: unexpected response`);
    }
  }
  // One page of a list. Only 200 with fewer than `count` rows (including []) ends a list; anything else is an error.
  private async page(path: string, page: number): Promise<Row[]> {
    const at = `${path}${path.includes('?') ? '&' : '?'}count=${PAGE}&page=${page}`;
    const answer = await this.get(at);
    // A 400 "pagination scan limit exceeded" is the node refusing to read further, not the end of the list.
    const rows = await this.json(at, answer);
    if (!Array.isArray(rows) || rows.length > PAGE) throw new Error(`Indexer ${path}: unexpected list`);
    return rows;
  }
  async readCommitment(txHash: string, owner: string): Promise<Confirmed> {
    if (!isTxHash(txHash) || !BECH32_ADDRESS.test(owner)) throw new Error('Invalid preprod commitment reference');
    const identity = identityKeyHash(owner);
    // The four transaction reads appear together on Dolos 1.6.1 (spike-dolos.md): 404 here means not indexed yet.
    const listed = await this.get(`/txs/${txHash}`);
    if (listed.status === 404) throw new NotIndexedError();
    const info = await this.json(`/txs/${txHash}`, listed);
    const raw = await this.get(`/txs/${txHash}/cbor`);
    // Listed without its bytes: never observed on Dolos, possible on other nodes; it may already be on chain.
    if (raw.status === 404) throw new CborPendingError();
    const { cbor } = await this.json(`/txs/${txHash}/cbor`, raw);
    if (typeof cbor !== 'string') throw new Error('Indexer transaction CBOR: unexpected response');
    const tx = readCommitmentTransaction(cbor, txHash);
    if (!tx.valid) throw new Error('Invalid transaction');
    if (!tx.signers.has(identity))
      throw new Error(
        'Organizer identity key did not sign the commitment (required signer witness missing or invalid)',
      );
    // PD10: a commitment withdraws from the organizer reward account. That needs the stake key's witness on the ledger
    // and lists the transaction under the account's withdrawals, the history uniqueness reads; read here from the
    // checked CBOR, so an indexer listing a transaction there cannot stand in for the withdrawal itself.
    if (!tx.withdrawals.has(identityRewardAccount(owner)))
      throw new Error('Commitment does not withdraw from the organizer stake reward account (required since PD10)');
    // The CBOR holds only input references; which address an input spends from is the indexer's report. Collateral
    // and reference inputs are not spent by a valid transaction.
    const utxos = await this.json(`/txs/${txHash}/utxos`);
    const spent = Array.isArray(utxos.inputs) ? utxos.inputs.filter((x: Row) => !x.collateral && !x.reference) : [];
    if (!spent.some((x: Row) => x.address === owner)) throw new Error('Organizer address is not a transaction input');
    if (info.hash !== txHash) throw new Error('Invalid inclusion block');
    const inclusion = this.inclusionFrom(txHash, owner, info, tx);
    // The tip says whether the 15th block exists; that block's own time is the confirmation time.
    const height = inclusion.blockHeight + CONFIRMATIONS - 1;
    const tip = await this.json('/blocks/latest');
    if (!Number.isSafeInteger(tip.height)) throw new Error('Invalid chain tip');
    if (tip.height < height) throw new Error(`Waiting for ${CONFIRMATIONS} confirmations`);
    const block = await this.json(`/blocks/${height}`);
    if (block.height !== height || !Number.isSafeInteger(block.time))
      throw new Error('Invalid confirmation block time');
    const slot = tx.invalidHereafter;
    return { ...inclusion, confirmedAt: block.time, validUntil: slot === null ? null : preprodSlotTime(slot) };
  }
  // `row` is the indexer's transaction or list row: its block height and time are indexer evidence; `tx` was read
  // from CBOR.
  private inclusionFrom(txHash: string, owner: string, row: Row, tx: CommitmentTransaction): Inclusion {
    const m = tx.metadata;
    if (!m) throw new Error('Unsupported commitment metadata');
    if (!Number.isSafeInteger(row.block_height) || !Number.isSafeInteger(row.block_time))
      throw new Error('Invalid inclusion block');
    return {
      txHash,
      owner,
      bundleHash: m.bundleHash,
      drawId: m.drawId,
      round: m.round,
      blockHeight: row.block_height,
      blockTime: row.block_time,
    };
  }
  // Every commitment of the owner's identity included before the round, whatever its drawId or round; uniqueness
  // compares their intervals. The history is the reward account's withdrawal list (PD10): every commitment withdraws
  // from it and only the stake key can add a row, so rows paid to addresses that merely carry the organizer's stake
  // part never appear and cost nothing. The list is read in ascending order and stops at the first row included at or
  // after the round: such a commitment cannot overlap [inclusion, round) (checkUniqueness), and rows the organizer
  // adds after the draw neither count toward L nor cost requests.
  async findCommitments(owner: string, round: number): Promise<Inclusion[]> {
    if (!BECH32_ADDRESS.test(owner)) throw new Error('Invalid organizer address');
    if (!Number.isSafeInteger(round)) throw new Error('Invalid round');
    const signer = identityKeyHash(owner);
    const account = identityOf(owner).key;
    const end = roundTime(round);
    const rows: Row[] = [];
    const seen = new Set<string>();
    let previous = { height: -1, time: -1 };
    read: for (let page = 1; ; page++) {
      // Any non-2xx answer fails the whole history (IndexerError): the missing page may hold the conflict. An unknown
      // account (404) is not an empty history: the referenced commitment itself withdraws from it.
      const listed = await this.page(`/accounts/${account}/withdrawals?order=asc`, page);
      for (const row of listed) {
        if (!isTxHash(row.tx_hash) || !Number.isSafeInteger(row.block_height) || !Number.isSafeInteger(row.block_time))
          throw new Error('Invalid withdrawal list');
        // A transaction withdraws from one account at most once. The stop below relies on the ascending order: a list
        // seen out of order (Yaci Store 0.12.0 ignores `order`, spike-withdrawal.md) may hold a pre-round row behind
        // the first row past the round, so it fails. A node that places one there without showing any disorder is
        // omitting it, which the verifier trusts the indexer not to do (docs/protocol-development.md).
        if (seen.has(row.tx_hash)) throw new Error('Inconsistent withdrawal list');
        if (row.block_height < previous.height || row.block_time < previous.time)
          throw new Error('Withdrawal list is not in ascending order');
        previous = { height: row.block_height, time: row.block_time };
        if (row.block_time >= end) break read;
        seen.add(row.tx_hash);
        rows.push(row);
        if (rows.length > HISTORY_ROW_LIMIT) throw historyTooLarge();
      }
      if (listed.length < PAGE) break;
    }
    const found: Inclusion[] = [];
    for (const row of rows) {
      // The indexer's metadata JSON only selects which transactions to read as CBOR: hiding a commitment here is
      // no different from leaving it out of the enumeration, and everything counted is read from checked CBOR.
      const metadata = await this.json(`/txs/${row.tx_hash}/metadata`);
      if (!Array.isArray(metadata)) throw new Error('Indexer transaction metadata: unexpected response');
      if (metadata.find((x: Row) => x?.label === String(LABEL))?.json_metadata?.protocol !== VERSION) continue;
      const raw = await this.get(`/txs/${row.tx_hash}/cbor`);
      // An enumerated transaction whose bytes are not served is missing evidence, never an absent transaction.
      if (raw.status === 404) throw new Error('Organizer history transaction evidence is incomplete');
      const { cbor } = await this.json(`/txs/${row.tx_hash}/cbor`, raw);
      if (typeof cbor !== 'string') throw new Error('Organizer history transaction evidence is incomplete');
      const tx = readCommitmentTransaction(cbor, row.tx_hash);
      // Only the identity key's verified signature makes a transaction this identity's commitment (PD3). A real
      // ledger already refuses a withdrawal without the stake key's witness; an indexer or a chain that lists one
      // anyway (the Dolos emulator does not validate withdrawals) still cannot make it count. Which address the
      // inputs spend from is not consulted, so the same wallet committing from another payment address is counted.
      // A malformed entry in the identity's own signed transaction still fails the history (inclusionFrom).
      if (!tx.valid || !tx.signers.has(signer) || (!tx.metadata && !tx.malformed)) continue;
      found.push(this.inclusionFrom(row.tx_hash, owner, row, tx));
    }
    return found;
  }
}
