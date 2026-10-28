export { MockSocial, MockVcsHost } from "@devagent/gateway";

// TODO(verify): real GitHub adapter (git data API or authenticated git push from the gateway host) and real X adapter
// (official X API v2 create-post endpoint, OAuth 2.0 user context). Both stay unimplemented until the owner supplies
// credentials and the official docs are checked. They must only ever be constructed inside the gateway process.
export class NotConfigured extends Error {
  constructor(what: string) {
    super(`${what} adapter is not configured (TODO(verify): implement against official docs)`);
  }
}
export class GitHubHost {
  async push(): Promise<{ ref: string }> {
    throw new NotConfigured("GitHub");
  }
}
export class XSocial {
  async post(): Promise<{ ref: string }> {
    throw new NotConfigured("X");
  }
}
