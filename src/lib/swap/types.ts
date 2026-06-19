export type SwapInput = { videoUrl: string; imageUrl: string };
export interface SwapProvider {
  swap(input: SwapInput): Promise<string>;
}
