export type Verdict = { ok: true } | { ok: false; rule: string };

type Rule = [name: string, re: RegExp];

// Never talk about price, returns or buying; never solicit; never discuss secrets.
const OUTBOUND: Rule[] = [
  ["cashtag", /\$[A-Za-z]{2,10}\b/],
  [
    "buy-call",
    /\b(buy|sell|hold|ape|aping|accumulate)\b[^.\n]{0,40}\b(token|coin|ticker|bag|supply|presale|dip)\b/i,
  ],
  [
    "price-talk",
    /\b(price (target|prediction|action)|market ?cap|mcap|all[- ]time high|bonding curve)\b/i,
  ],
  ["hype", /\b(to the moon|moon(ing)?|lambo|wagmi|100x|1000x|\d+x (gains?|returns?))\b/i],
  [
    "financial-promise",
    /\b(guaranteed|risk[- ]free|profit|roi|apy|passive income|financial advice)\b/i,
  ],
  ["solicitation", /\b(airdrop|giveaway|dm me|send (me )?(sol|usdc|eth|btc)|whitelist|presale)\b/i],
  ["secrets-talk", /\b(seed phrase|private key|secret key|mnemonic|api key|access token)\b/i],
];

const MENTION: Rule = ["mention", /(^|[^\w])@\w{1,15}\b/];

// Deployer prompts: refuse harmful projects and attempts to override the agent rules.
const PROMPT: Rule[] = [
  ["malware", /\b(malware|ransomware|keylogger|botnet|ddos|exploit kit|trojan|spyware|stealer)\b/i],
  [
    "phishing",
    /\b(phishing|credential (harvest|steal)|fake (login|wallet|airdrop)|wallet[- ]?drainer|drainer)\b/i,
  ],
  [
    "scam",
    /\b(rug ?pull|ponzi|pump and dump|pump & dump|fake (reviews?|testimonials?)|guaranteed returns)\b/i,
  ],
  ["harassment", /\b(harass|doxx?|stalk|threaten)\b/i],
  [
    "exfiltration",
    /\b(send|post|upload|leak)\b.{0,40}\b(env(ironment)? variables?|api keys?|secrets?|private keys?|seed phrase)/i,
  ],
  ["override", /ignore (all |any )?(previous|prior|above) (instructions|rules)/i],
];

const run = (rules: Rule[], text: string): Verdict => {
  for (const [rule, re] of rules) if (re.test(text)) return { ok: false, rule };
  return { ok: true };
};

/** Text that leaves the system (posts, commit messages). */
export const checkOutbound = (text: string): Verdict => run(OUTBOUND, text);

/** Posts additionally never mention other accounts. */
export const checkPost = (text: string): Verdict => run([...OUTBOUND, MENTION], text);

/** The deployer's locked prompt, checked before an agent is created. */
export const checkPrompt = (text: string): Verdict => run(PROMPT, text);
