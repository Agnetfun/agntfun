/** Per agent credentials for GitHub and X. Only the gateway process may hold a vault. */
export type CredentialKind = "github" | "x";
export interface Vault {
  get(agentId: string, kind: CredentialKind): string | undefined;
}
export class MemoryVault implements Vault {
  private m = new Map<string, string>();
  set(agentId: string, kind: CredentialKind, secret: string) {
    this.m.set(`${agentId}:${kind}`, secret);
  }
  get(agentId: string, kind: CredentialKind) {
    return this.m.get(`${agentId}:${kind}`);
  }
}
