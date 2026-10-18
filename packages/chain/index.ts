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

// Private development label, absent from the CIP-10 registry (checked 2026-10-18 at CIPs commit befcdb7);
// registration is left to the v1 freeze.
export const LABEL = 20261018;
export const DEFAULT_INDEXER = 'https://preprod.koios.rest/api/v1';
export function commitmentMetadata(bundle: Bundle, bundleHash: string) {
  return { protocol: VERSION, drawId: bundle.drawId, bundleHash, chainHash: QUICKNET, round: bundle.drand.round };
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
    return { ...inclusion, confirmedAt: roundTime(inclusion.round) + (late ? 1 : -300) };
  }
  // The verifier's view of a demo draw: always confirmed on time, because there is no chain to ask.
  async readCommitment(bundle: Bundle): Promise<Confirmed> {
    const inclusion = await demoInclusion(bundle);
    return { ...inclusion, confirmedAt: roundTime(inclusion.round) - 300 };
  }
}
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
// biome-ignore lint/suspicious/noExplicitAny: Koios rows are untyped JSON; step 7 replaces these reads with CBOR checks.
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
    const rows = await this.query('tx_info', { _tx_hashes: [txHash], _inputs: true, _metadata: true });
    const tx = rows.find((x) => x.tx_hash === txHash);
    // Metadata is separately queried so the result does not depend on a provider's default flags.
    const metaRows = await this.query('tx_metadata', { _tx_hashes: [txHash] });
    const m = metaRows.find((x) => x.tx_hash === txHash)?.metadata?.[LABEL];
    const inclusion = this.inclusionFrom(txHash, owner, tx, m);
    const height = inclusion.blockHeight + CONFIRMATIONS - 1;
    const blocks = await this.query(`blocks?block_height=eq.${height}&limit=1`);
    const block = blocks.find((x) => x.block_height === height);
    if (!block) throw new Error(`Waiting for ${CONFIRMATIONS} confirmations`);
    if (!Number.isSafeInteger(block.block_time)) throw new Error('Invalid confirmation block time');
    return { ...inclusion, confirmedAt: block.block_time };
  }
  private inclusionFrom(txHash: string, owner: string, tx: Row | undefined, m: Row | undefined): Inclusion {
    if (!tx) throw new Error('Transaction is not indexed yet');
    if (tx.valid_contract === false) throw new Error('Invalid transaction');
    if (!tx.inputs?.some((x: Row) => x.payment_addr?.bech32 === owner))
      throw new Error('Organizer address is not a transaction input');
    if (
      !m ||
      m.protocol !== VERSION ||
      m.chainHash !== QUICKNET ||
      !/^[a-f0-9]{64}$/.test(m.bundleHash) ||
      typeof m.drawId !== 'string' ||
      !Number.isSafeInteger(m.round)
    )
      throw new Error('Unsupported commitment metadata');
    if (!Number.isSafeInteger(tx.block_height) || !Number.isSafeInteger(tx.tx_timestamp))
      throw new Error('Invalid inclusion block');
    return {
      txHash,
      owner,
      bundleHash: m.bundleHash,
      drawId: m.drawId,
      round: m.round,
      blockHeight: tx.block_height,
      blockTime: tx.tx_timestamp,
    };
  }
  // Every commitment of the owner's identity, whatever its drawId or round; uniqueness compares their intervals.
  async findCommitments(owner: string): Promise<Inclusion[]> {
    if (!/^addr_test1[a-z0-9]+$/.test(owner)) throw new Error('Invalid organizer address');
    const identity = identityOf(owner);
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
      const rows = await this.query('tx_metadata', { _tx_hashes: hashes.slice(i, i + batch) });
      const matching = rows.filter((row) => row.metadata?.[LABEL]?.protocol === VERSION);
      if (!matching.length) continue;
      // Koios leaves `inputs` empty unless `_inputs` is requested (measured on preprod, 2026-10-19).
      const transactions = await this.query('tx_info', {
        _tx_hashes: matching.map((row) => row.tx_hash),
        _inputs: true,
      });
      for (const row of matching) {
        const m = row.metadata?.[LABEL];
        const tx = transactions.find((x) => x.tx_hash === row.tx_hash);
        if (!tx || !Array.isArray(tx.inputs)) throw new Error('Organizer history transaction evidence is incomplete');
        // Until step 7 checks the identity key's witness, a transaction counts only when it spends from the owner
        // address itself: the ledger then requires the owner's payment key signature, so neither an incoming
        // transfer nor a third party using the owner's stake part in its own address can create a commitment.
        if (tx.valid_contract === false || !tx.inputs.some((x: Row) => x.payment_addr?.bech32 === owner)) continue;
        found.push(this.inclusionFrom(row.tx_hash, owner, tx, m));
      }
    }
    return found;
  }
}
