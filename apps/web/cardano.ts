// Loaded only by the creation flow (dynamic import in app.ts): verifiers never download the transaction SDK.
import * as Address from '@evolution-sdk/evolution/Address';
import * as Assets from '@evolution-sdk/evolution/Assets';
import * as Transaction from '@evolution-sdk/evolution/Transaction';
import * as TransactionHash from '@evolution-sdk/evolution/TransactionHash';
import * as TransactionInput from '@evolution-sdk/evolution/TransactionInput';
import * as TransactionMetadatum from '@evolution-sdk/evolution/TransactionMetadatum';
import { preprod } from '@evolution-sdk/evolution/sdk/client/Chain';
import { makeTxBuilder } from '@evolution-sdk/evolution/sdk/builders/TransactionBuilder';
import { Koios } from '@evolution-sdk/evolution/sdk/provider/Koios';
import { computeCommitment, hex, unhex, type Bundle } from '@giveaway/protocol';
import {
  checkCommitmentTransaction,
  commitmentMetadata,
  COMMITMENT_TRANSFER,
  decodeCborAll,
  DEFAULT_INDEXER,
  isCborArray,
  isCborMap,
  LABEL,
  transactionHash,
  transactionParts,
} from '@giveaway/chain';

// The subset of CIP-30 this page calls (https://cips.cardano.org/cip/CIP-0030).
interface Cip30Api {
  getNetworkId(): Promise<number>;
  getChangeAddress(): Promise<string>;
  getUtxos(): Promise<string[] | null>;
  signTx(tx: string, partialSign?: boolean): Promise<string>;
}
interface Cip30Wallet {
  name?: string;
  icon?: string;
  apiVersion?: string;
  enable?: () => Promise<Cip30Api>;
}
const injected = () => (window as { cardano?: Record<string, Cip30Wallet | undefined> }).cardano ?? {};

export function wallets(): { id: string; name: string }[] {
  return Object.entries(injected()).flatMap(([id, w]) =>
    w && typeof w.name === 'string' && w.icon !== undefined && w.apiVersion !== undefined ? [{ id, name: w.name }] : [],
  );
}
// A CIP-30 UTxO is the CBOR pair [transaction_input, transaction_output]; only ADA-only outputs are candidates.
function walletUtxo(cbor: string) {
  try {
    const pair = decodeCborAll(unhex(cbor)).value;
    if (!isCborArray(pair) || pair.length !== 2 || !isCborArray(pair[0])) return null;
    const [txId, index] = pair[0];
    const output = pair[1];
    const [address, amount] = isCborMap(output) ? [output.get(0), output.get(1)] : isCborArray(output) ? output : [];
    if (!(txId instanceof Uint8Array) || typeof index !== 'bigint' || !(address instanceof Uint8Array)) return null;
    if (typeof amount !== 'bigint') return null;
    return { txHash: hex(txId), index, address: hex(address), lovelace: amount };
  } catch {
    return null;
  }
}
const metadatum = (value: Record<string, string | number>) =>
  TransactionMetadatum.fromEntries(
    Object.entries(value).map(([k, v]) => [k, typeof v === 'number' ? TransactionMetadatum.int(BigInt(v)) : v]),
  );

export async function prepareTransaction(bundle: Bundle, id: string) {
  const enable = injected()[id]?.enable;
  if (!id || typeof enable !== 'function')
    throw new Error('Install and enable a CIP-30 wallet in this browser, then refresh wallets');
  const wallet = await enable();
  if ((await wallet.getNetworkId()) !== 0)
    throw new Error('Switch your wallet to preprod. Mainnet is disabled in this development version.');
  const provider = new Koios(DEFAULT_INDEXER);
  const params = await provider.getProtocolParameters();
  const candidate = ((await wallet.getUtxos()) ?? []).map(walletUtxo).find((u) => u !== null && u.lovelace >= 5000000n);
  if (!candidate) throw new Error('Need an ADA-only preprod UTxO with at least 5 test ADA');
  const [verified] = await provider.getUtxosByOutRef([
    new TransactionInput.TransactionInput({
      transactionId: TransactionHash.fromHex(candidate.txHash),
      index: candidate.index,
    }),
  ]);
  if (
    !verified ||
    Address.toHex(verified.address) !== candidate.address ||
    !Assets.hasOnlyLovelace(verified.assets) ||
    Assets.lovelaceOf(verified.assets) !== candidate.lovelace
  )
    throw new Error('Wallet UTxO is not on preprod');
  const changeAddress = await wallet.getChangeAddress();
  const address = Address.fromHex(changeAddress);
  const metadata = commitmentMetadata(bundle, await computeCommitment(bundle));
  const built = await makeTxBuilder({ chain: preprod })
    .payToAddress({ address, assets: Assets.fromLovelace(COMMITMENT_TRANSFER) })
    .attachMetadata({ label: BigInt(LABEL), metadata: metadatum(metadata) })
    .build({ fullProtocolParameters: params, availableUtxos: [verified], changeAddress: address });
  const unsigned = Transaction.toCBORHex(await built.toTransaction());
  // Re-read the SDK's output with the trust-path reader; a mismatch stops here, before the wallet sees it.
  const checked = checkCommitmentTransaction(unsigned, {
    input: { txHash: candidate.txHash, index: Number(candidate.index), lovelace: candidate.lovelace },
    address: changeAddress,
    metadata,
  });
  return {
    owner: Address.toBech32(verified.address),
    bytes: unsigned.length / 2,
    fee: Number(checked.fee) / 1000000,
    async signAndSubmit(): Promise<string> {
      if ((await wallet.getNetworkId()) !== 0) throw new Error('Mainnet is disabled');
      const signed = Transaction.addVKeyWitnessesHex(unsigned, await wallet.signTx(unsigned, false));
      if (transactionHash(signed) !== checked.txHash) throw new Error('Signing changed the transaction body');
      const fee = transactionParts(signed).body.get(2);
      if (
        typeof fee !== 'bigint' ||
        fee > 2n * (BigInt(params.minFeeA) * BigInt(signed.length / 2) + BigInt(params.minFeeB))
      )
        throw new Error('Fee exceeds twice the live protocol estimate');
      // The signed bytes go to Koios unchanged: re-encoding through an SDK could alter them (spike S1).
      const response = await fetch(`${DEFAULT_INDEXER}/submittx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/cbor' },
        body: new Uint8Array(unhex(signed)),
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(`Submission failed: HTTP ${response.status} ${await response.text()}`);
      const txHash = await response.json();
      if (typeof txHash !== 'string' || !/^[a-f0-9]{64}$/.test(txHash))
        throw new Error('Unexpected submission response');
      return txHash;
    },
  };
}
