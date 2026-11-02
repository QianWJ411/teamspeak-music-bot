import type { BotPlugin } from "./types.js";
import { createJmPlugin } from "./jm/index.js";

/**
 * Built-in plugins compiled into the bot.
 *
 * The list stays explicit (rather than scanning the filesystem) so the server
 * build is deterministic and a deployment cannot execute arbitrary local code.
 */
export function createBuiltinPlugins(): BotPlugin[] {
  return [createJmPlugin()];
}
