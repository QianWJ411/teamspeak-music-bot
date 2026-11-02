import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import type { JmConfig, ProxySettings } from "./types.js";
import { agentFor } from "./proxy.js";
import type { Logger } from "../../logger.js";

export interface Chapter {
  photoId: string;
  sort: number;
  name: string;
}

export interface Album {
  id: string;
  title: string;
  chapters: Chapter[];
}

export interface Photo {
  photoId: string;
  albumId: string;
  sort: number;
  title: string;
  scrambleId: number;
  domain: string;
  images: string[];
}

export class JmError extends Error {}

export function parseAlbumId(raw: string): string {
  const value = raw.trim();
  if (/^\d{1,12}$/.test(value)) {
    return value;
  }
  const jm = /^jm(\d{1,12})$/i.exec(value);
  if (jm) {
    return jm[1];
  }
  const link = /(?:photos?|albums?)\/(\d{1,12})/i.exec(value);
  if (link) {
    return link[1];
  }
  const query = /[?&]id=(\d{1,12})/i.exec(value);
  if (query) {
    return query[1];
  }
  throw new JmError("无法识别的编号：请发送本子 ID（如 422578）或作品链接");
}

export function parseRange(text: string | undefined): Set<number> {
  const out = new Set<number>();
  if (!text) {
    return out;
  }
  for (const part of text.split(",")) {
    const piece = part.trim();
    const range = /^(\d+)\s*[-~到]\s*(\d+)$/.exec(piece);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
        out.add(i);
      }
      continue;
    }
    if (/^\d+$/.test(piece)) {
      out.add(Number(piece));
    }
  }
  return out;
}

export function segmentCount(photoId: string, scrambleId: number, imageName: string): number {
  const aid = Number(photoId);
  if (!Number.isFinite(aid) || aid < scrambleId) {
    return 0;
  }
  if (aid < 268850) {
    return 10;
  }
  const mod = aid < 421926 ? 10 : 8;
  const digest = crypto.createHash("md5").update(photoId + imageName).digest("hex");
  return (digest.charCodeAt(digest.length - 1) % mod) * 2 + 2;
}

/** 纯函数版条带还原，方便离线自测。 */
export function descrambleRaw(
  width: number,
  height: number,
  channels: number,
  data: Buffer,
  num: number,
): Buffer {
  if (num <= 0 || height < num) {
    return data;
  }
  const out = Buffer.alloc(data.length);
  const move = Math.floor(height / num);
  const over = height % num;
  const rowBytes = width * channels;
  for (let i = 0; i < num; i++) {
    let bandHeight = move;
    const ySrc = height - move * (i + 1) - over;
    let yDst = move * i;
    if (i === 0) {
      bandHeight += over;
    } else {
      yDst += over;
    }
    if (bandHeight <= 0 || ySrc < 0) {
      continue;
    }
    const srcStart = ySrc * rowBytes;
    const dstStart = yDst * rowBytes;
    data.copy(out, dstStart, srcStart, srcStart + bandHeight * rowBytes);
  }
  return out;
}

interface FetchOptions {
  proxy: ProxySettings;
  referer?: string;
  timeoutMs?: number;
  accept?: string;
  fetchDest?: "document" | "image";
  headers?: Record<string, string>;
}

async function fetchBuffer(url: string, options: FetchOptions): Promise<Buffer> {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const target = new URL(current);
    const agent = agentFor(options.proxy, target);
    const lib = target.protocol === "https:" ? https : http;
    const buffer = await new Promise<Buffer>((resolve, reject) => {
      const req = lib.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (target.protocol === "https:" ? 443 : 80),
          path: `${target.pathname}${target.search}`,
          method: "GET",
          agent,
          headers: {
            "user-agent": "Mozilla/5.0",
            accept:
              options.accept ??
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
            "accept-encoding": "identity",
            "upgrade-insecure-requests": "1",
            "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Windows"',
            "sec-fetch-dest": options.fetchDest ?? "document",
            "sec-fetch-mode": options.fetchDest === "image" ? "no-cors" : "navigate",
            "sec-fetch-site": "same-origin",
            referer: options.referer ?? `${target.origin}/`,
            ...(options.headers ?? {}),
          },
          timeout: options.timeoutMs ?? 30_000,
        },
        (res) => {
          const location = res.headers.location;
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && location) {
            res.resume();
            reject(new RedirectError(new URL(location, current).toString()));
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            reject(
              new Error(
                res.statusCode === 403
                  ? "HTTP 403"
                  : `HTTP ${res.statusCode}`,
              ),
            );
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 30 * 1024 * 1024) {
              req.destroy(new Error("图片超过 30MB"));
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => resolve(Buffer.concat(chunks)));
        },
      );
      req.on("timeout", () => req.destroy(new Error("请求超时")));
      req.on("error", reject);
      req.end();
    }).catch((error: unknown) => {
      if (error instanceof RedirectError) {
        return error;
      }
      throw error;
    });
    if (buffer instanceof RedirectError) {
      current = buffer.url;
      continue;
    }
    return buffer;
  }
  throw new Error("重定向次数过多");
}

class RedirectError extends Error {
  constructor(readonly url: string) {
    super("redirect");
  }
}

export interface DownloadResult {
  album: Album;
  chapters: number;
  pages: number;
  files: string[];
}

// === 禁漫移动端 API（参考 JMComic-Crawler-Python 的 JmApiClient） ===
const API_TOKEN_SECRET = "185Hcomic3PAPP7R";
const API_CONTENT_SECRET = "18comicAPPContent";
const API_APP_VERSION = "2.1.12";
const API_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 9; V1938CT Build/PQ3A.190705.11211812; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/91.0.4472.114 Safari/537.36";
const API_CDN_HOSTS = [
  "cdn-msp.jmapiproxy2.cc",
  "cdn-msp2.jmapiproxy2.cc",
  "cdn-msp3.jmapiproxy2.cc",
  "cdn-msp.jmapinodeudzn.net",
  "cdn-msp.jmapiproxy1.cc",
];

function apiTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}

function apiToken(ts: number, secret: string): string {
  return crypto.createHash("md5").update(`${ts}${secret}`).digest("hex");
}

async function apiRaw(
  domain: string,
  pathname: string,
  params: Record<string, string | number>,
  secret: string,
  proxy: ProxySettings,
): Promise<{ text: string; ts: number }> {
  const ts = apiTimestamp();
  const query = new URLSearchParams({
    ...Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])),
  });
  const host = domain.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  const url = `https://${host}${pathname}?${query.toString()}`;
  const body = await fetchBuffer(url, {
    proxy,
    timeoutMs: 20_000,
    headers: {
      "user-agent": API_USER_AGENT,
      accept: "application/json",
      "accept-encoding": "identity",
      "x-requested-with": "com.JMComic3.app",
      referer: "https://18comic.vip/",
      token: apiToken(ts, secret),
      tokenparam: `${ts},${API_APP_VERSION}`,
    },
  });
  return { text: body.toString("utf8"), ts };
}

async function apiJson<T>(
  domain: string,
  pathname: string,
  params: Record<string, string | number>,
  proxy: ProxySettings,
): Promise<T> {
  const { text, ts } = await apiRaw(domain, pathname, params, API_TOKEN_SECRET, proxy);
  let outer: { code?: number; data?: string; errorMsg?: string };
  try {
    outer = JSON.parse(text) as { code?: number; data?: string; errorMsg?: string };
  } catch {
    throw new JmError(`API 返回不是 JSON：${text.slice(0, 80)}`);
  }
  if (outer.code !== 200 || !outer.data) {
    throw new JmError(`API 返回错误：${outer.errorMsg ?? outer.code ?? "无数据"}`);
  }
  const key = Buffer.from(
    crypto.createHash("md5").update(`${ts}${API_TOKEN_SECRET}`).digest("hex"),
    "utf8",
  );
  const decipher = crypto.createDecipheriv("aes-256-ecb", key, null);
  const plain = Buffer.concat([decipher.update(Buffer.from(outer.data, "base64")), decipher.final()]);
  return JSON.parse(plain.toString("utf8")) as T;
}

interface ApiAlbum {
  id: number | string;
  name?: string;
  series_id?: string;
  series?: Array<{ id: string | number; name?: string; sort?: string | number }>;
}

interface ApiChapter {
  id: number | string;
  name?: string;
  series_id?: string;
  images?: string[];
}

/** 面板「测试站点」：访问移动端 API，确认域名与 token 可用。 */
export async function probeComic(
  settings: { domains: string[] },
  proxy: ProxySettings,
): Promise<{ status: number; challenged: boolean; length: number; title: string; domain: string }> {
  let lastError = "";
  const direct: ProxySettings = { mode: "off", host: "", port: 0, user: "", password: "" };
  for (const domain of settings.domains) {
    for (const candidate of proxy.mode === "off" ? [proxy] : [proxy, direct]) {
      try {
        const data = await apiJson<ApiAlbum>(domain, "/album", { id: "350234" }, candidate);
        return {
          status: 200,
          challenged: false,
          length: 0,
          title: String(data.name ?? ""),
          domain,
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (candidate.mode !== "off" && /ECONNREFUSED|ETIMEDOUT/i.test(lastError)) {
          console.warn(`代理不可用，测试 API 改为直连：${lastError}`);
          continue;
        }
        console.warn(`API 域名 ${domain} 不可用：${lastError}`);
        break;
      }
    }
  }
  throw new Error(`所有 API 域名都不可用：${lastError}`);
}

export async function unscrambleImage(
  photo: Photo,
  imageName: string,
  data: Buffer,
  jpegQuality = 92,
): Promise<{ buffer: Buffer; width: number; height: number } | null> {
  const stem = imageName.replace(/\.[a-z0-9]{2,5}$/i, "");
  const num = segmentCount(photo.photoId, photo.scrambleId, stem);
  try {
    const { data: raw, info } = await sharp(data, { limitInputPixels: false })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const fixed = num > 0 ? descrambleRaw(info.width, info.height, info.channels, raw, num) : raw;
    const jpeg = await sharp(fixed, {
      raw: { width: info.width, height: info.height, channels: info.channels },
    })
      .jpeg({ quality: jpegQuality })
      .toBuffer();
    return { buffer: jpeg, width: info.width, height: info.height };
  } catch (error) {
    console.warn(`图片 ${imageName} 无法解码，跳过：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export class JmDownloader {
  constructor(
    private readonly config: JmConfig,
    private readonly log: Logger,
  ) {}

  private cdnHost = "";

  async download(albumId: string, range: Set<number>): Promise<DownloadResult> {
    const comic = this.config.comic;
    const proxy: ProxySettings = {
      mode: this.config.proxy.mode,
      host: this.config.proxy.host,
      port: this.config.proxy.port,
      user: this.config.proxy.user,
      password: this.config.proxy.password,
    };
    const { album, domain } = await this.fetchAlbum(albumId, proxy);
    const selected = album.chapters
      .filter((chapter) => range.size === 0 || range.has(chapter.sort))
      .slice(0, comic.maxChapters);
    if (selected.length === 0) {
      throw new JmError(`按范围没有可下载的章节（共 ${album.chapters.length} 话）`);
    }
    const albumDir = path.join(comic.dir, `JM${album.id}`);
    fs.mkdirSync(albumDir, { recursive: true });

    const pdfPath = path.join(albumDir, `${album.id}.pdf`);
    const pdf = new PdfWriter(pdfPath, album.title);
    for (const chapter of selected) {
      const photo = await this.fetchChapter(domain, album, chapter, proxy);
      await this.downloadChapter(album, chapter, photo, pdf, proxy);
      this.log.info(`JM${album.id} 第${chapter.sort}话完成（${photo.images.length} 张）`);
    }
    if (pdf.pageCount === 0) {
      await pdf.close().catch(() => {});
      throw new JmError("没有下载到任何图片，PDF 未生成");
    }
    await pdf.close();
    fs.writeFileSync(
      path.join(albumDir, "meta.json"),
      `${JSON.stringify(
        {
          album: album.id,
          pages: pdf.pageCount,
          chapters: selected.length,
          full: range.size === 0,
          at: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return { album, chapters: selected.length, pages: pdf.pageCount, files: [pdfPath] };
  }

  /** 参考 JmApiClient：/album?id=xxx，series 即章节列表。 */
  private async fetchAlbum(
    albumId: string,
    proxy: ProxySettings,
  ): Promise<{ album: Album; domain: string }> {
    let lastError = "";
    for (const domain of this.config.comic.domains) {
      try {
        let data = await apiJson<ApiAlbum>(domain, "/album", { id: albumId }, proxy);
        if (!data.name) {
          throw new JmError("专辑不存在或没有 name");
        }
        let id = String(data.id ?? albumId);
        const seriesId = String(data.series_id ?? "");
        if (seriesId && seriesId !== "0" && seriesId !== id) {
          data = await apiJson<ApiAlbum>(domain, "/album", { id: seriesId }, proxy);
          id = String(data.id ?? seriesId);
        }
        const chapters: Chapter[] = (data.series ?? []).map((item, index) => ({
          photoId: String(item.id),
          sort: Number(item.sort) || index + 1,
          name: String(item.name ?? ""),
        }));
        if (chapters.length === 0) {
          chapters.push({ photoId: id, sort: 1, name: "" });
        }
        this.log.info(`JM${id} 使用 API 域名 ${domain}，共 ${chapters.length} 话`);
        return {
          album: { id, title: String(data.name ?? `JM${id}`), chapters },
          domain,
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        this.log.warn(`API 域名 ${domain} 拉取失败：${lastError}`);
      }
    }
    throw new JmError(`所有 API 域名都拉取失败：${lastError}`);
  }

  /** 参考 JmApiClient：/chapter?id=xxx + /chapter_view_template 获取 scramble_id。 */
  private async fetchChapter(
    domain: string,
    album: Album,
    chapter: Chapter,
    proxy: ProxySettings,
  ): Promise<Photo> {
    const data = await apiJson<ApiChapter>(domain, "/chapter", { id: chapter.photoId }, proxy);
    if (!data.images || data.images.length === 0) {
      throw new JmError(`第${chapter.sort}话没有图片`);
    }
    const scrambleId = await this.fetchScrambleId(domain, chapter.photoId, proxy);
    return {
      photoId: chapter.photoId,
      albumId: album.id,
      sort: chapter.sort,
      title: chapter.name,
      scrambleId,
      domain,
      images: data.images,
    };
  }

  private async fetchScrambleId(
    domain: string,
    photoId: string,
    proxy: ProxySettings,
  ): Promise<number> {
    try {
      const { text } = await apiRaw(
        domain,
        "/chapter_view_template",
        {
          id: photoId,
          mode: "vertical",
          page: 0,
          app_img_shunt: 1,
          express: "off",
          v: apiTimestamp(),
        },
        API_CONTENT_SECRET,
        proxy,
      );
      const match = /var\s+scramble_id\s*=\s*(\d+);/.exec(text);
      return match ? Number(match[1]) : 220980;
    } catch (error) {
      this.log.warn(`第 ${photoId} 话 scramble_id 获取失败，按 220980 处理：${error instanceof Error ? error.message : String(error)}`);
      return 220980;
    }
  }

  /** 代理没启动时自动回退直连，避免 Clash Verge 没开就完全不能用。 */
  private async fetchWithFallback(
    url: string,
    options: Omit<FetchOptions, "proxy">,
    proxy: ProxySettings,
  ): Promise<Buffer> {
    try {
      return await fetchBuffer(url, { ...options, proxy });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const proxyDown = /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/i.test(message);
      if (proxy.mode !== "off" && proxyDown) {
        this.log.warn(`代理 ${proxy.host}:${proxy.port} 不可用，改为直连：${message}`);
        return fetchBuffer(url, { ...options, proxy: { mode: "off", host: "", port: 0, user: "", password: "" } });
      }
      throw error;
    }
  }

  private async downloadChapter(
    album: Album,
    chapter: Chapter,
    photo: Photo,
    pdf: PdfWriter,
    proxy: ProxySettings,
  ): Promise<void> {
    const limit = Math.min(photo.images.length, 400);
    for (let i = 0; i < limit; i++) {
      const imageName = photo.images[i];
      const data = await this.downloadImage(photo, imageName, proxy);
      const fixed = await unscrambleImage(photo, imageName, data, this.config.comic.jpegQuality);
      if (!fixed) {
        continue;
      }
      pdf.add(fixed.buffer, fixed.width, fixed.height);
      if (i % 5 === 0) {
        this.log.info(`JM${album.id} 第${chapter.sort}话 图片 ${i + 1}/${limit}`);
      }
    }
  }

  private async downloadImage(photo: Photo, imageName: string, proxy: ProxySettings): Promise<Buffer> {
    const hosts = this.cdnHost
      ? [this.cdnHost, ...API_CDN_HOSTS.filter((host) => host !== this.cdnHost)]
      : API_CDN_HOSTS;
    let lastError = "";
    for (const host of hosts) {
      try {
        const buffer = await this.fetchWithFallback(
          `https://${host}/media/photos/${photo.photoId}/${imageName}`,
          {
            referer: `https://${photo.domain.replace(/^https?:\/\//i, "").replace(/\/.*$/, "")}/`,
            accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
            fetchDest: "image",
            headers: {
              "user-agent": API_USER_AGENT,
              "x-requested-with": "com.JMComic3.app",
            },
          },
          proxy,
        );
        this.cdnHost = host;
        return buffer;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    throw new JmError(`图片 ${imageName} 所有 CDN 都失败：${lastError}`);
  }

}

class PdfWriter {
  private readonly doc: PDFKit.PDFDocument;
  private readonly output: fs.WriteStream;
  private readonly done: Promise<void>;
  private closed = false;
  pageCount = 0;

  constructor(file: string, title: string) {
    this.doc = new PDFDocument({
      autoFirstPage: false,
      compress: true,
      info: { Title: title, Creator: "TS-JMcomic-Bot" },
    });
    this.output = fs.createWriteStream(file);
    this.done = new Promise<void>((resolve, reject) => {
      this.output.on("close", () => resolve());
      this.output.on("error", reject);
      this.doc.on("error", reject);
    });
    this.doc.pipe(this.output);
  }

  add(buffer: Buffer, width: number, height: number): void {
    const max = 14_000;
    const scale = Math.min(1, max / width, max / height);
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    this.doc.addPage({ size: [w, h], margin: 0 });
    this.doc.image(buffer, 0, 0, { width: w, height: h });
    this.pageCount += 1;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.doc.end();
    await this.done;
  }
}
