import { computeCommitment, CONFIRMATIONS, roundTime, VERSION, QUICKNET,
  type Bundle, type Commitment, sha256 } from '../protocol/index.ts';

export const LABEL = 674; // Temporary development label; not a CIP-10 registration.
export const DEFAULT_INDEXER = 'https://preprod.koios.rest/api/v1';
export function commitmentMetadata(bundle: Bundle, bundleHash: string) {
  return { protocol: VERSION, drawId: bundle.drawId, bundleHash, chainHash: QUICKNET, round: bundle.drand.round };
}
export class DemoChain {
  readonly network = 'demo';
  commitments: Commitment[] = [];
  async commit(bundle: Bundle): Promise<Commitment> {
    const bundleHash = await computeCommitment(bundle);
    const c: Commitment = { txHash: await sha256(crypto.randomUUID()), owner: 'demo-organizer',
      bundleHash, drawId: bundle.drawId, round: bundle.drand.round, blockHeight: 1000 + this.commitments.length,
      blockTime: roundTime(bundle.drand.round) - 900, confirmedAt: 0 };
    this.commitments.push(c); return c;
  }
  confirm(c: Commitment, late = false): Commitment {
    c.confirmedAt = roundTime(c.round) + (late ? 1 : -300); return c;
  }
}
type Row = Record<string, any>;
export class KoiosChain {
  constructor(readonly base = DEFAULT_INDEXER) {
    const url = new URL(base);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Indexer must be an HTTPS URL without credentials');
  }
  async query(endpoint: string, body?: object): Promise<Row[]> {
    const response = await fetch(`${this.base.replace(/\/$/, '')}/${endpoint}`, {
      method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`Indexer ${endpoint}: HTTP ${response.status}`);
    const rows = await response.json(); if (!Array.isArray(rows)) throw new Error('Unexpected indexer response');
    return rows;
  }
  async readCommitment(txHash: string, owner: string): Promise<Commitment> {
    if (!/^[a-f0-9]{64}$/.test(txHash) || !/^addr_test1[a-z0-9]+$/.test(owner)) throw new Error('Invalid preprod commitment reference');
    const rows = await this.query('tx_info', { _tx_hashes: [txHash], _metadata: true });
    const tx = rows.find(x => x.tx_hash === txHash);
    // Metadata is separately queried so the result does not depend on a provider's default flags.
    const metaRows = await this.query('tx_metadata', { _tx_hashes: [txHash] });
    const m = metaRows.find(x => x.tx_hash === txHash)?.metadata?.[LABEL];
    return this.commitmentFrom(txHash, owner, tx, m, true);
  }
  private async commitmentFrom(txHash: string, owner: string, tx: Row | undefined, m: Row | undefined, requireConfirmations: boolean): Promise<Commitment> {
    if (!tx) throw new Error('Transaction is not indexed yet');
    if (tx.valid_contract === false) throw new Error('Invalid transaction');
    if (!tx.inputs?.some((x: Row) => x.payment_addr?.bech32 === owner)) throw new Error('Organizer address is not a transaction input');
    if (!m || m.protocol !== VERSION || m.chainHash !== QUICKNET ||
        !/^[a-f0-9]{64}$/.test(m.bundleHash) || typeof m.drawId !== 'string' || !Number.isSafeInteger(m.round)) throw new Error('Unsupported commitment metadata');
    if (!Number.isSafeInteger(tx.block_height) || !Number.isSafeInteger(tx.tx_timestamp)) throw new Error('Invalid inclusion block');
    let confirmedAt = 0;
    if (requireConfirmations) {
      const blocks = await this.query(`blocks?block_height=eq.${tx.block_height + CONFIRMATIONS - 1}&limit=1`);
      const block = blocks.find(x => x.block_height === tx.block_height + CONFIRMATIONS - 1);
      if (!block) throw new Error(`Waiting for ${CONFIRMATIONS} confirmations`);
      if (!Number.isSafeInteger(block.block_time)) throw new Error('Invalid confirmation block time');
      confirmedAt = block.block_time;
    }
    return { txHash, owner, bundleHash: m.bundleHash, drawId: m.drawId, round: m.round,
      blockHeight: tx.block_height, blockTime: tx.tx_timestamp, confirmedAt };
  }
  async findCommitments(drawId: string, owner: string): Promise<Commitment[]> {
    if (!/^addr_test1[a-z0-9]+$/.test(owner)) throw new Error('Invalid organizer address');
    const hashes: string[] = [];
    const pageSize = 500;
    for (let offset = 0; ; offset += pageSize) {
      const page = await this.query(`address_txs?limit=${pageSize}&offset=${offset}&order=block_height.asc`, { _addresses: [owner] });
      for (const x of page) { if (!/^[a-f0-9]{64}$/.test(x.tx_hash)) throw new Error('Invalid transaction list'); hashes.push(x.tx_hash); }
      if (page.length < pageSize) break;
      if (offset + pageSize >= 5000) throw new Error('Address history exceeds development query limit; uniqueness cannot be established');
    }
    const found: Commitment[] = [];
    for (let i = 0; i < hashes.length; i += 100) {
      const rows = await this.query('tx_metadata', { _tx_hashes: hashes.slice(i, i + 100) });
      const matching = rows.filter(row => row.metadata?.[LABEL]?.protocol === VERSION && row.metadata[LABEL].drawId === drawId);
      if (!matching.length) continue;
      const transactions = await this.query('tx_info', { _tx_hashes: matching.map(row => row.tx_hash) });
      for (const row of matching) {
        const m = row.metadata?.[LABEL];
        const tx = transactions.find(x => x.tx_hash === row.tx_hash);
        if (!tx || !Array.isArray(tx.inputs)) throw new Error('Address history transaction evidence is incomplete');
        // Incoming transfers cannot create commitments on behalf of the recipient.
        if (tx.valid_contract === false || !tx.inputs.some((x: Row) => x.payment_addr?.bech32 === owner)) continue;
        found.push(await this.commitmentFrom(row.tx_hash, owner, tx, m, false));
      }
    }
    return found;
  }
}
