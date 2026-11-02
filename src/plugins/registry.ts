import type {
  BotPlugin,
  PluginCommand,
  PluginLifecycleContext,
} from "./types.js";

interface RegisteredCommand {
  plugin: BotPlugin;
  command: PluginCommand;
}

/**
 * Small, dependency-free command/plugin registry.
 *
 * Plugins are compiled into the bot for now (no dynamic `import()` of arbitrary
 * local code). The registry is intentionally strict: duplicate plugin ids,
 * duplicate command names, and names reserved by the core bot fail fast at
 * construction time instead of shadowing built-ins at runtime.
 */
export class PluginRegistry {
  private readonly plugins: BotPlugin[] = [];
  private readonly commands = new Map<string, RegisteredCommand>();
  private readonly aliases = new Map<string, string>();
  private readonly initialized = new Set<string>();
  private readonly failed = new Set<string>();

  constructor(
    plugins: BotPlugin[] = [],
    reservedCommands: ReadonlySet<string> = new Set(),
  ) {
    for (const plugin of plugins) {
      this.register(plugin, reservedCommands);
    }
  }

  register(
    plugin: BotPlugin,
    reservedCommands: ReadonlySet<string> = new Set(),
  ): void {
    if (!plugin.id.trim()) {
      throw new Error("Plugin id must not be empty");
    }
    if (this.plugins.some((p) => p.id === plugin.id)) {
      throw new Error(`Duplicate plugin id: ${plugin.id}`);
    }

    const lower = (value: string) => value.trim().toLowerCase();
    const pluginCommands = new Map<string, PluginCommand>();

    for (const command of plugin.commands) {
      const name = lower(command.name);
      if (!name) {
        throw new Error(`Plugin ${plugin.id} has a command with an empty name`);
      }
      if (reservedCommands.has(name)) {
        throw new Error(
          `Plugin ${plugin.id} cannot override built-in command "${name}"`,
        );
      }
      if (pluginCommands.has(name) || this.commands.has(name)) {
        throw new Error(`Duplicate command name: ${name}`);
      }

      for (const alias of command.aliases ?? []) {
        const normalized = lower(alias);
        if (!normalized) continue;
        if (
          reservedCommands.has(normalized) ||
          pluginCommands.has(normalized) ||
          this.commands.has(normalized) ||
          this.aliases.has(normalized)
        ) {
          throw new Error(
            `Plugin ${plugin.id} cannot register duplicate alias "${normalized}"`,
          );
        }
        pluginCommands.set(normalized, command);
      }

      pluginCommands.set(name, command);
    }

    this.plugins.push(plugin);
    for (const [name, command] of pluginCommands) {
      if (command.name.toLowerCase() === name) {
        this.commands.set(name, { plugin, command });
      } else {
        this.aliases.set(name, command.name.toLowerCase());
      }
    }
  }

  get size(): number {
    return this.plugins.length;
  }

  list(): BotPlugin[] {
    return [...this.plugins];
  }

  /** Alias map suitable for parseCommand(). */
  aliasMap(): Record<string, string> {
    return Object.fromEntries(this.aliases);
  }

  getCommand(name: string): RegisteredCommand | undefined {
    const key = name.trim().toLowerCase();
    const direct = this.commands.get(key);
    if (direct) {
      return this.failed.has(direct.plugin.id) ? undefined : direct;
    }
    const canonical = this.aliases.get(key);
    if (!canonical) return undefined;
    const command = this.commands.get(canonical);
    return command && !this.failed.has(command.plugin.id) ? command : undefined;
  }

  isAdminCommand(name: string): boolean {
    return this.getCommand(name)?.command.adminOnly === true;
  }

  /** Human-readable command lines for the core !help output. */
  helpLines(prefix: string): string[] {
    const lines: string[] = [];
    for (const { command } of this.commands.values()) {
      if (command.help) {
        lines.push(`${prefix}${command.name} — ${command.help}`);
      }
    }
    return lines;
  }

  async initAll(ctx: PluginLifecycleContext): Promise<void> {
    this.failed.clear();
    for (const plugin of this.plugins) {
      if (this.initialized.has(plugin.id)) continue;
      try {
        await plugin.init?.(ctx);
        this.initialized.add(plugin.id);
        ctx.logger.info({ pluginId: plugin.id }, "Plugin initialized");
      } catch (err) {
        this.failed.add(plugin.id);
        ctx.logger.error(
          { err, pluginId: plugin.id },
          "Plugin init failed; continuing without it",
        );
      }
    }
  }

  async disposeAll(ctx: PluginLifecycleContext): Promise<void> {
    for (const plugin of [...this.plugins].reverse()) {
      if (!this.initialized.has(plugin.id)) continue;
      try {
        await plugin.dispose?.(ctx);
        this.initialized.delete(plugin.id);
        ctx.logger.info({ pluginId: plugin.id }, "Plugin disposed");
      } catch (err) {
        ctx.logger.error(
          { err, pluginId: plugin.id },
          "Plugin dispose failed; continuing teardown",
        );
      }
    }
  }
}
