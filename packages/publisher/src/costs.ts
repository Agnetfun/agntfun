// X API pay per use prices (X developer pricing page, "Credit consumption details", seen by the owner Oct 2026):
//   Post: Create $0.015 per request; Content: Create with URL $0.20 per request;
//   Posts: Read $0.005 per post fetched; User: Read $0.010 per user fetched.
// The ledger counts whole cents, so prices round UP (an agent never pays less than X charges the platform).
export const POST_CENTS = 2; // $0.015
export const POST_WITH_LINK_CENTS = 20; // $0.20, 13x a plain post: links are off unless X_POST_LINKS=1
export const USER_READ_CENTS = 1; // $0.010

export const postCostCents = (linked: boolean) => (linked ? POST_WITH_LINK_CENTS : POST_CENTS);
/** Reading n mentions at $0.005 each. */
export const mentionReadCents = (n: number) => Math.ceil(n * 0.5);

/** Most a post may cost. Links cost $0.20 per post on X, so they are only allowed when the owner opts in. */
export const maxPostCentsFromEnv = (env: Record<string, string | undefined> = process.env) =>
  env.X_POST_LINKS === "1" ? POST_WITH_LINK_CENTS : POST_CENTS;
