import fs from "node:fs";
import path from "node:path";

/**
 * 已下载完整的 PDF 缓存。
 * 只复用无话数范围的整本；范围下载会写 meta.full=false，避免把半本当整本。
 */
export function existingPdf(downloadDir: string, albumId: string): string | null {
  const dir = path.join(downloadDir, `JM${albumId}`);
  const file = path.join(dir, `${albumId}.pdf`);
  try {
    if (!fs.existsSync(file)) {
      return null;
    }
    const stat = fs.statSync(file);
    if (stat.size < 1024) {
      return null;
    }
    const fd = fs.openSync(file, "r");
    const head = Buffer.alloc(5);
    fs.readSync(fd, head, 0, 5, 0);
    fs.closeSync(fd);
    if (head.toString("ascii") !== "%PDF-") {
      return null;
    }
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as {
        full?: boolean;
      };
      if (meta.full === false) {
        return null;
      }
    } catch {
      // 旧缓存没有 meta.json，按完整文件处理
    }
    return file;
  } catch {
    return null;
  }
}
