import {
  BlsG1,
  BlsG2,
  bls12_381_G1_uncompress,
  bls12_381_G2_uncompress,
  bls12_381_G1_hashToGroup,
  bls12_381_millerLoop,
  bls12_381_finalVerify,
} from '@harmoniclabs/crypto';
import { sha256, unhex, QUICKNET, type Beacon } from '../protocol/index.ts';

// Pinned from the official quicknet announcement, never from an untrusted relay /info response.
export const PUBLIC_KEY =
  '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a';
const DST = new TextEncoder().encode('BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_');
export const FIXTURE: Beacon = {
  round: 1000000,
  randomness: 'b22aad4794f7451896f7a371aa46106fd84d919f3f569acd5b2fddf1d1440af3',
  signature: '83ad29e4c409f9470fc2ef02f90214df49e02b441a1a241a82d622d9f608ef98fd8b11a029f1bee9d9e83b45088abe72',
};
export async function verifyBeacon(beacon: Beacon, expectedRound: number): Promise<boolean> {
  try {
    if (
      !Number.isSafeInteger(expectedRound) ||
      expectedRound < 1 ||
      beacon.round !== expectedRound ||
      !/^[a-f0-9]{96}$/.test(beacon.signature) ||
      !/^[a-f0-9]{64}$/.test(beacon.randomness)
    )
      return false;
    const encoded = new Uint8Array(8);
    new DataView(encoded.buffer).setBigUint64(0, BigInt(expectedRound), false);
    const message = unhex(await sha256(encoded));
    const signature = bls12_381_G1_uncompress(unhex(beacon.signature));
    const publicKey = bls12_381_G2_uncompress(unhex(PUBLIC_KEY));
    if (signature.equals(BlsG1.ZERO) || publicKey.equals(BlsG2.ZERO)) return false;
    const hash = bls12_381_G1_hashToGroup(message, DST);
    return (
      bls12_381_finalVerify(bls12_381_millerLoop(signature, BlsG2.BASE), bls12_381_millerLoop(hash, publicKey)) &&
      (await sha256(unhex(beacon.signature))) === beacon.randomness
    );
  } catch {
    return false;
  }
}
export async function fetchBeacon(round: number): Promise<Beacon> {
  const failures: string[] = [];
  for (const host of ['https://api.drand.sh', 'https://api2.drand.sh']) {
    try {
      const response = await fetch(`${host}/${QUICKNET}/public/${round}`, { signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const beacon = (await response.json()) as Beacon;
      if (!(await verifyBeacon(beacon, round))) throw new Error('Invalid BLS signature or randomness');
      return { round: beacon.round, signature: beacon.signature, randomness: beacon.randomness };
    } catch (e) {
      failures.push(`${host}: ${(e as Error).message}`);
    }
  }
  throw new Error(`No verified beacon available. ${failures.join('; ')}`);
}
