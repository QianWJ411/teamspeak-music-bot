import fs from "node:fs";
import path from "node:path";

export interface DownloadRecord {
  albumId: string;
  title: string;
  pages: number;
  chapters: number;
  pdf: string;
  downloadedAt: string;
  deliveredAt?: string;
  deliveredMode?: "direct" | "client";
}

/** 已下载清单，保存在 data/downloaded.json；机器人用它判断是否下过。 */
export class DownloadCatalog {
  private readonly file: string;
  private records: Record<string, DownloadRecord> = {};

  constructor(file = path.join("data", "downloaded.json")) {
    this.file = file;
    this.load();
  }

  get(albumId: string): DownloadRecord | undefined {
    return this.records[albumId];
  }

  list(): DownloadRecord[] {
    return Object.values(this.records).sort((a, b) => b.downloadedAt.localeCompare(a.downloadedAt));
  }

  add(record: DownloadRecord): void {
    this.records[record.albumId] = { ...this.records[record.albumId], ...record };
    this.save();
  }

  markDelivered(albumId: string, mode: "direct" | "client"): void {
    const record = this.records[albumId];
    if (!record) {
      return;
    }
    record.deliveredAt = new Date().toISOString();
    record.deliveredMode = mode;
    this.save();
  }

  remove(albumId: string): void {
    if (this.records[albumId]) {
      delete this.records[albumId];
      this.save();
    }
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as
        | Record<string, DownloadRecord>
        | DownloadRecord[];
      if (Array.isArray(raw)) {
        for (const item of raw) {
          if (item && item.albumId) {
            this.records[item.albumId] = item;
          }
        }
      } else if (raw && typeof raw === "object") {
        this.records = raw;
      }
    } catch {
      this.records = {};
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.records, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, this.file);
  }
}
