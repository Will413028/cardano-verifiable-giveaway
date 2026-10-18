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
    const rows = await this.query('tx_info', { _tx_hashes: [txHash], _metadata: true });
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
  async findCommitments(drawId: string, owner: string): Promise<Inclusion[]> {
    if (!/^addr_test1[a-z0-9]+$/.test(owner)) throw new Error('Invalid organizer address');
    const hashes: string[] = [];
    const pageSize = 500;
    for (let offset = 0; ; offset += pageSize) {
      const page = await this.query(`address_txs?limit=${pageSize}&offset=${offset}&order=block_height.asc`, {
        _addresses: [owner],
      });
      for (const x of page) {
        if (!/^[a-f0-9]{64}$/.test(x.tx_hash)) throw new Error('Invalid transaction list');
        hashes.push(x.tx_hash);
      }
      if (page.length < pageSize) break;
      if (offset + pageSize >= 5000)
        throw new Error('Address history exceeds development query limit; uniqueness cannot be established');
    }
    const found: Inclusion[] = [];
    for (let i = 0; i < hashes.length; i += 100) {
      const rows = await this.query('tx_metadata', { _tx_hashes: hashes.slice(i, i + 100) });
      const matching = rows.filter(
        (row) => row.metadata?.[LABEL]?.protocol === VERSION && row.metadata[LABEL].drawId === drawId,
      );
      if (!matching.length) continue;
      const transactions = await this.query('tx_info', { _tx_hashes: matching.map((row) => row.tx_hash) });
      for (const row of matching) {
        const m = row.metadata?.[LABEL];
        const tx = transactions.find((x) => x.tx_hash === row.tx_hash);
        if (!tx || !Array.isArray(tx.inputs)) throw new Error('Address history transaction evidence is incomplete');
        // Incoming transfers cannot create commitments on behalf of the recipient.
        if (tx.valid_contract === false || !tx.inputs.some((x: Row) => x.payment_addr?.bech32 === owner)) continue;
        found.push(this.inclusionFrom(row.tx_hash, owner, tx, m));
      }
    }
    return found;
  }
}
