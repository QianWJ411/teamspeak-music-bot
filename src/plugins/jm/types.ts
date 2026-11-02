export type ProxyMode = "off" | "http" | "socks5";

export interface ProxySettings {
  mode: ProxyMode;
  host: string;
  port: number;
  user: string;
  password: string;
}

export interface JmConfig {
  proxy: ProxySettings;
  comic: {
    domains: string[];
    /** Absolute directory for downloaded PDFs and metadata. */
    dir: string;
    maxChapters: number;
    jpegQuality: number;
  };
}
