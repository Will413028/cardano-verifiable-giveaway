import type { Bundle, Commitment } from '@giveaway/protocol';
import type { prepareTransaction } from './cardano.ts';

export type PreparedTransaction = Awaited<ReturnType<typeof prepareTransaction>>;

// Everything the page remembers between events; one instance is created per page load.
export interface AppState {
  busy: boolean;
  draw: { bundle?: Bundle; commitment?: Commitment; transaction?: PreparedTransaction };
  poll?: ReturnType<typeof setTimeout>;
  downloadUrl: string;
  verifiedBundle?: Bundle;
}

export function createState(): AppState {
  return { busy: false, draw: {}, downloadUrl: '' };
}
