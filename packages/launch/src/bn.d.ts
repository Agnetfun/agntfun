// Minimal types for bn.js (the pump.fun SDK's big number class); only what this package uses.
declare module "bn.js" {
  export default class BN {
    constructor(n: number | string | bigint);
    toString(base?: number): string;
  }
}
