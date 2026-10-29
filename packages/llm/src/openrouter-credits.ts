/**
 * OpenRouter credit left, so the owner tops up (with crypto, on openrouter.ai) before agents stall.
 * GET https://openrouter.ai/api/v1/credits -> { data: { total_credits, total_usage } }. It needs a MANAGEMENT key,
 * which is separate from the key agents use and never enters a session.
 */
export async function openRouterCreditsLeft(managementKey: string, fetchFn: typeof fetch = fetch): Promise<number> {
  const r = await fetchFn("https://openrouter.ai/api/v1/credits", {
    method: "GET",
    headers: { authorization: `Bearer ${managementKey}` },
  });
  if (!r.ok) throw new Error(`openrouter credits ${r.status}`);
  const j = JSON.parse(await r.text()) as { data?: { total_credits?: number; total_usage?: number } };
  if (typeof j.data?.total_credits !== "number" || typeof j.data.total_usage !== "number")
    throw new Error("openrouter credits: unexpected response");
  return j.data.total_credits - j.data.total_usage;
}
