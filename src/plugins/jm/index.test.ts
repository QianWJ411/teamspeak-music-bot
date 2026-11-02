import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJmPlugin } from "./index.js";
import type { PluginCommandContext, PluginLifecycleContext } from "../types.js";
import type { BotConfig } from "../../data/config.js";
import type { Logger } from "../../logger.js";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => logger,
} as unknown as Logger;

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jm-plugin-"));
  tempDirs.push(dir);
  return dir;
}

function lifecycle(dir: string): PluginLifecycleContext {
  return {
    botId: "bot-1",
    logger,
    config: {} as BotConfig,
    dataDir: dir,
    sendText: vi.fn(async () => {}),
    uploadFile: vi.fn(async () => {}),
    getChannelId: () => 22n,
  };
}

function commandContext(dir: string, args: string): PluginCommandContext {
  return {
    ...lifecycle(dir),
    pluginId: "jm-comic",
    args,
    rawArgs: args ? args.split(/\s+/) : [],
    flags: new Set(),
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("JM plugin", () => {
  it("registers the jm command and exposes help", () => {
    const plugin = createJmPlugin();
    expect(plugin.id).toBe("jm-comic");
    expect(plugin.commands[0].name).toBe("jm");
    expect(plugin.commands[0].help).toContain("JM");
  });

  it("writes a config and download directory on init", async () => {
    const dir = tempDir();
    const plugin = createJmPlugin();
    await plugin.init?.(lifecycle(dir));

    expect(fs.existsSync(path.join(dir, "config.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "downloads"))).toBe(false);
    const config = JSON.parse(
      fs.readFileSync(path.join(dir, "config.json"), "utf8"),
    ) as { comic: { downloadDir: string } };
    expect(config.comic.downloadDir).toBe(path.join(dir, "downloads"));
  });

  it("returns usage for an empty command", async () => {
    const dir = tempDir();
    const plugin = createJmPlugin();
    await plugin.init?.(lifecycle(dir));
    const result = await plugin.commands[0].execute(commandContext(dir, ""));
    expect(result).toContain("用法");
  });
});
