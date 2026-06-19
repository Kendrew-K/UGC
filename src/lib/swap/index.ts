import type { SwapProvider } from './types';
import { falProvider } from './fal';
import { replicateProvider } from './replicate';

export type { SwapProvider, SwapInput } from './types';

export function getSwapProvider(name = process.env.SWAP_PROVIDER ?? 'fal'): SwapProvider {
  if (name === 'fal') return falProvider;
  if (name === 'replicate') return replicateProvider;
  throw new Error(`Unknown swap provider: ${name}`);
}
