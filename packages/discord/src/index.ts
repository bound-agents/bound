// Export bot
export { DiscordBot, shouldActivate } from "./bot";
export type { AgentLoopFactory } from "./bot";

// Export allowlist
export { isAllowlisted } from "./allowlist";

// Export thread mapping
export { findOrCreateThread, mapDiscordUser } from "./thread-mapping";
