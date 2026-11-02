import { describe, expect, it, vi } from "vitest";
import { BUILTIN_COMMANDS, parseCommand } from "../bot/commands.js";
import { PluginRegistry } from "./registry.js";
import type {
  BotPlugin,
  PluginLifecycleContext,
} from "./types.js";
import type { BotConfig } from "../data/config.js";
import type { Logger } from "../logger.js";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => logger,
} as unknown as Logger;

function context(): PluginLifecycleContext {
  return {
    botId: "bot-1",
    logger,
    config: {} as BotConfig,
    dataDir: "data/plugins",
    sendText: vi.fn(async () => {}),
    uploadFile: vi.fn(async () => {}),
    getChannelId: () => 0n,
  };
}

function demoPlugin(overrides: Partial<BotPlugin> = {}): BotPlugin {
  return {
    id: "demo",
    commands: [
      {
        name: "jm",
        aliases: ["manga"],
        adminOnly: true,
        help: "download a comic",
        execute: vi.fn(async () => "done"),
      },
    ],
    init: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("PluginRegistry", () => {
  it("registers commands and aliases", () => {
    const registry = new PluginRegistry([demoPlugin()], BUILTIN_COMMANDS);
    expect(registry.size).toBe(1);
    expect(registry.getCommand("jm")?.command.name).toBe("jm");
    expect(registry.getCommand("MANGA")?.command.name).toBe("jm");
    expect(registry.isAdminCommand("jm")).toBe(true);
    expect(registry.isAdminCommand("manga")).toBe(true);
    expect(registry.aliasMap()).toEqual({ manga: "jm" });
    expect(registry.helpLines("!")).toEqual(["!jm — download a comic"]);
  });

  it("resolves plugin aliases through parseCommand", () => {
    const registry = new PluginRegistry([demoPlugin()], BUILTIN_COMMANDS);
    const parsed = parseCommand("!manga 123", "!", registry.aliasMap());
    expect(parsed?.name).toBe("jm");
    expect(parsed?.args).toBe("123");
  });

  it("refuses to shadow a built-in command", () => {
    const plugin = demoPlugin({
      commands: [
        {
          name: "play",
          execute: () => null,
        },
      ],
    });
    expect(() => new PluginRegistry([plugin], BUILTIN_COMMANDS)).toThrow(
      /built-in command "play"/,
    );
  });

  it("refuses duplicate plugin ids and command names", () => {
    expect(
      () => new PluginRegistry([demoPlugin(), demoPlugin()], BUILTIN_COMMANDS),
    ).toThrow(/Duplicate plugin id/);

    const duplicateCommands = demoPlugin({
      commands: [
        { name: "jm", execute: () => null },
        { name: "jm", execute: () => null },
      ],
    });
    expect(
      () => new PluginRegistry([duplicateCommands], BUILTIN_COMMANDS),
    ).toThrow(/Duplicate command name/);
  });

  it("runs init and dispose once per plugin", async () => {
    const plugin = demoPlugin();
    const registry = new PluginRegistry([plugin], BUILTIN_COMMANDS);
    const ctx = context();

    await registry.initAll(ctx);
    await registry.initAll(ctx);
    expect(plugin.init).toHaveBeenCalledTimes(1);

    await registry.disposeAll(ctx);
    await registry.disposeAll(ctx);
    expect(plugin.dispose).toHaveBeenCalledTimes(1);
  });

  it("keeps the bot alive when one plugin fails to init", async () => {
    const failing = demoPlugin({
      id: "broken",
      commands: [
        { name: "brokencmd", execute: () => null },
      ],
      init: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const registry = new PluginRegistry([failing], BUILTIN_COMMANDS);
    const ctx = context();

    await expect(registry.initAll(ctx)).resolves.toBeUndefined();
    expect(registry.getCommand("brokencmd")).toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});
