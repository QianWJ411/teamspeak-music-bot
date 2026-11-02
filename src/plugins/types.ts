import type { BotConfig } from "../data/config.js";
import type { TS3TextMessage } from "../ts-protocol/client.js";
import type { Logger } from "../logger.js";

/** Everything a plugin command gets at execution time. */
export interface PluginCommandContext {
  botId: string;
  pluginId: string;
  args: string;
  rawArgs: string[];
  flags: Set<string>;
  message?: TS3TextMessage;
  requesterName?: string;
  logger: Logger;
  config: BotConfig;
  dataDir: string;
  /** Send text to the bot's current TeamSpeak channel. */
  sendText(text: string): Promise<void>;
  /** Current channel id (0n before the client is connected). */
  getChannelId(): bigint;
}

/** Lifecycle context used by init()/dispose(). */
export interface PluginLifecycleContext {
  botId: string;
  logger: Logger;
  config: BotConfig;
  dataDir: string;
  sendText(text: string): Promise<void>;
  getChannelId(): bigint;
}

export interface PluginCommand {
  name: string;
  aliases?: string[];
  /** When true, the existing adminGroups gate applies to this command. */
  adminOnly?: boolean;
  help?: string;
  execute(
    ctx: PluginCommandContext,
  ): Promise<string | null> | string | null;
}

/** A plugin is a group of commands plus optional connect/disconnect hooks. */
export interface BotPlugin {
  id: string;
  name?: string;
  commands: PluginCommand[];
  init?(ctx: PluginLifecycleContext): Promise<void> | void;
  dispose?(ctx: PluginLifecycleContext): Promise<void> | void;
}
