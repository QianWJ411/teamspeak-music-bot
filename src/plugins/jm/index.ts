import fs from "node:fs";
import path from "node:path";
import type { BotPlugin, PluginCommandContext, PluginLifecycleContext } from "../types.js";
import {
  JmDownloader,
  parseAlbumId,
  parseRange,
  type DownloadResult,
} from "./jm.js";
import { existingPdf } from "./cache.js";
import { DownloadCatalog } from "./catalog.js";
import type { JmConfig, ProxySettings } from "./types.js";

interface JmPluginFileConfig {
  proxy: ProxySettings;
  comic: {
    domains: string[];
    downloadDir: string;
    uploadDir: string;
    maxChapters: number;
    jpegQuality: number;
  };
}

const DEFAULT_CONFIG: JmPluginFileConfig = {
  proxy: {
    mode: "http",
    host: "127.0.0.1",
    port: 7897,
    user: "",
    password: "",
  },
  comic: {
    domains: [
      "https://www.cdngwc.cc",
      "https://www.cdngwc.net",
      "https://www.cdngwc.club",
      "https://www.cdnhjk.net",
    ],
    downloadDir: "",
    uploadDir: "",
    maxChapters: 30,
    jpegQuality: 85,
  },
};

function loadConfig(dataDir: string): JmPluginFileConfig {
  const file = path.join(dataDir, "config.json");
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf8");
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<JmPluginFileConfig>;
  const merged: JmPluginFileConfig = {
    proxy: { ...DEFAULT_CONFIG.proxy, ...raw.proxy },
    comic: {
      ...DEFAULT_CONFIG.comic,
      ...raw.comic,
      downloadDir: raw.comic?.downloadDir || path.join(dataDir, "downloads"),
    },
  };
  if (!raw.comic?.downloadDir) {
    fs.writeFileSync(file, JSON.stringify(merged, null, 2), "utf8");
  }
  return merged;
}

function directCopyDir(uploadDir: string, channelId: bigint): string {
  return uploadDir
    .replace(/\{channelId\}/gi, channelId.toString())
    .replace(/\{channelDir\}/gi, `channel_${channelId}`);
}

async function deliverPdf(
  ctx: PluginCommandContext,
  config: JmPluginFileConfig,
  pdf: string,
): Promise<"direct" | "client"> {
  const uploadDir = config.comic.uploadDir.trim();
  if (uploadDir) {
    const dir = directCopyDir(uploadDir, ctx.getChannelId());
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(pdf, path.join(dir, path.basename(pdf)));
    return "direct";
  }
  await ctx.uploadFile(pdf, `/${path.basename(pdf)}`);
  return "client";
}

async function deliver(
  ctx: PluginCommandContext,
  config: JmPluginFileConfig,
  result: DownloadResult,
): Promise<"direct" | "client"> {
  const pdf = result.files[0];
  if (!pdf) {
    throw new Error("下载完成但没有生成 PDF");
  }
  return deliverPdf(ctx, config, pdf);
}

export function createJmPlugin(): BotPlugin {
  let config: JmPluginFileConfig | null = null;
  let downloading = false;
  let catalog: DownloadCatalog | null = null;
  let downloader: JmDownloader | null = null;

  return {
    id: "jm-comic",
    name: "JM comic downloader",
    commands: [
      {
        name: "jm",
        adminOnly: false,
        help: "下载 JM 漫画：!jm <本子ID|链接> [话数范围] [--force|--send]",
        execute: async (ctx) => {
          if (!config || !catalog || !downloader) {
            throw new Error("JM 插件尚未初始化");
          }
          if (!ctx.args) {
            return "用法：!jm <本子ID|链接> [话数范围] [--force|--send]";
          }
          if (downloading) {
            return "正在下载另一本，完成后再试";
          }

          const force = /(?:^|\s)--force(?:\s|$)/.test(ctx.args);
          const send = /(?:^|\s)--send(?:\s|$)/.test(ctx.args);
          const cleaned = ctx.args
            .replace(/(?:^|\s)--(?:force|send)(?=\s|$)/g, " ")
            .replace(/\s+/g, " ")
            .trim();
          const [albumArg, rangeArg] = cleaned.split(/\s+/);
          if (!albumArg) {
            return "用法：!jm <本子ID|链接> [话数范围] [--force|--send]";
          }

          const albumId = parseAlbumId(albumArg);
          const range = parseRange(rangeArg);
          const cached =
            range.size === 0 ? existingPdf(config.comic.downloadDir, albumId) : null;
          const record = catalog.get(albumId);

          if (send) {
            if (!cached) return `本地没有 JM${albumId}.pdf，无法发送`;
            if (!record) {
              catalog.add({
                albumId,
                title: `JM${albumId}`,
                pages: 0,
                chapters: 0,
                pdf: cached,
                downloadedAt: new Date().toISOString(),
              });
            }
            downloading = true;
            try {
              const mode = await deliverPdf(ctx, config, cached);
              catalog.markDelivered(albumId, mode);
              return "已完成";
            } finally {
              downloading = false;
            }
          }

          if (!force && range.size === 0 && cached) {
            if (!record) {
              catalog.add({
                albumId,
                title: `JM${albumId}`,
                pages: 0,
                chapters: 0,
                pdf: cached,
                downloadedAt: new Date().toISOString(),
              });
            }
            return "曾下载过，请在文件夹中寻找";
          }
          if (record && !cached) catalog.remove(albumId);

          downloading = true;
          try {
            await ctx.sendText("正在下载");
            const result = await downloader.download(albumId, range);
            const pdf = result.files[0] ?? "";
            catalog.add({
              albumId: result.album.id,
              title: result.album.title,
              pages: result.pages,
              chapters: result.chapters,
              pdf,
              downloadedAt: new Date().toISOString(),
            });
            const mode = await deliver(ctx, config, result);
            catalog.markDelivered(result.album.id, mode);
            return "已完成";
          } finally {
            downloading = false;
          }
        },
      },
    ],
    init: (ctx: PluginLifecycleContext) => {
      config = loadConfig(ctx.dataDir);
      catalog = new DownloadCatalog(path.join(ctx.dataDir, "downloaded.json"));
      const jmConfig: JmConfig = {
        proxy: config.proxy,
        comic: {
          domains: config.comic.domains,
          dir: config.comic.downloadDir,
          maxChapters: config.comic.maxChapters,
          jpegQuality: config.comic.jpegQuality,
        },
      };
      downloader = new JmDownloader(jmConfig, ctx.logger);
    },
  };
}
