/** The two models a developer can pick for their agent. */
export type ModelChoice = "opus" | "astra";
export const MODEL_CHOICES: readonly ModelChoice[] = ["opus", "astra"];

export type AgentState = "sleeping" | "waking" | "running" | "publishing" | "halted" | "starved";
