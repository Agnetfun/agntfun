import type { Share } from "./split";

export interface LaunchRequest {
  name: string;
  symbol: string;
  /** Metadata JSON location. pump.fun limits: name 32, symbol 13, uri 200 characters. */
  uri: string;
  creator: string;
  split: Share[];
}
export interface LaunchResult {
  mint: string;
  signature: string;
  sharingConfigSet: boolean;
}
export interface Distribution {
  signature: string;
  mint: string;
  shareholder: string;
  lamports: bigint;
  seq: number;
}

/** Everything the rest of the system needs from pump.fun. The mock and the real transaction builder sit behind it. */
export interface LaunchPad {
  launch(req: LaunchRequest): Promise<LaunchResult>;
  /** Distributions paid after `cursor`, oldest first. */
  distributionsSince(mint: string, cursor: number): Promise<Distribution[]>;
}

export const LIMITS = { name: 32, symbol: 13, uri: 200 } as const;

export function validateLaunch(r: LaunchRequest): void {
  if (!r.name || r.name.length > LIMITS.name)
    throw new Error(`name must be 1 to ${LIMITS.name} characters`);
  if (!r.symbol || r.symbol.length > LIMITS.symbol)
    throw new Error(`symbol must be 1 to ${LIMITS.symbol} characters`);
  if (!r.uri || r.uri.length > LIMITS.uri)
    throw new Error(`uri must be 1 to ${LIMITS.uri} characters`);
}
