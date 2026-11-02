import type { BotPlugin } from "./types.js";

/**
 * Built-in plugins compiled into the bot.
 *
 * The JM comic downloader will be registered here once it is ported. Keeping
 * this list explicit (rather than scanning the filesystem) makes the server
 * build deterministic and avoids arbitrary code loading.
 */
export function createBuiltinPlugins(): BotPlugin[] {
  return [];
}
