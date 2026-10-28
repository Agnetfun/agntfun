// TODO(verify): X API pricing. Treated as pay-per-use with a higher price when a post carries a link.
// These are placeholders so the meter and the budget logic can be tested; confirm against the official X pricing page.
export const POST_CENTS = 1;
export const POST_WITH_LINK_CENTS = 20;

export const postCostCents = (linked: boolean) => (linked ? POST_WITH_LINK_CENTS : POST_CENTS);
