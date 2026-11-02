# Plugin system

Plugins extend the bot with chat commands without editing the core command
`switch`. This first version is deliberately **compile-time only**: plugins are
imported by `src/plugins/builtin.ts` and bundled with the server. There is no
runtime loading of arbitrary files (yet), which keeps deployments deterministic
and avoids giving a random folder code execution.

## Contract

```ts
export interface BotPlugin {
  id: string;
  name?: string;
  commands: PluginCommand[];
  init?(ctx: PluginLifecycleContext): Promise<void> | void;
  dispose?(ctx: PluginLifecycleContext): Promise<void> | void;
}
```

A command declares:

- `name`: canonical chat command name
- `aliases`: optional alternative names
- `adminOnly`: reuse the existing `adminGroups` permission gate
- `help`: one line shown by `!help`
- `execute(ctx)`: return a reply string, or `null` for no reply

`PluginCommandContext` provides the parsed args/flags, the invoker message,
the bot's per-plugin data directory, `sendText()` for immediate channel
messages (useful for long-running work), and the current channel id.

## Example

```ts
import type { BotPlugin } from "./types.js";

export const jmPlugin: BotPlugin = {
  id: "jm-comic",
  commands: [
    {
      name: "jm",
      adminOnly: false,
      help: "download a JM comic",
      async execute(ctx) {
        await ctx.sendText("正在下载");
        // run the downloader, copy/upload the PDF, then:
        return "已完成";
      },
    },
  ],
};
```

Register it in `src/plugins/builtin.ts`:

```ts
import { jmPlugin } from "./jm/index.js";

export function createBuiltinPlugins() {
  return [jmPlugin];
}
```

## Guarantees

- A plugin cannot register a name already used by a core command.
- Duplicate plugin ids, command names, and aliases fail at startup.
- `adminOnly` commands go through the same live server-group lookup as core
  admin commands; an empty `adminGroups` keeps the existing "enforcement off"
  behavior.
- If `init()` throws, the plugin is marked unavailable and the bot keeps
  running; its commands are not executable until a later reconnect.
- `dispose()` runs before the next connect and is serialized with `init()`.
