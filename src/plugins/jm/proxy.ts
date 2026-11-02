import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import type { ProxySettings } from "./types.js";

export function proxyUrl(conf: ProxySettings): string {
  const auth =
    conf.user && conf.user.length > 0
      ? `${encodeURIComponent(conf.user)}:${encodeURIComponent(conf.password ?? "")}@`
      : "";
  const scheme = conf.mode === "socks5" ? "socks5" : "http";
  return `${scheme}://${auth}${conf.host}:${conf.port}`;
}

/** 给漫画下载请求用；TeamSpeak 客户端从不经过代理。 */
export function agentFor(conf: ProxySettings, target: URL): http.Agent | undefined {
  if (conf.mode === "off") {
    return undefined;
  }
  const url = proxyUrl(conf);
  if (conf.mode === "socks5") {
    return new SocksProxyAgent(url);
  }
  return new HttpsProxyAgent(url);
}

export function describeProxy(conf: ProxySettings): string {
  if (conf.mode === "off") {
    return "直连";
  }
  return `${conf.mode}://${conf.host}:${conf.port}`;
}

/** 面板「测试代理」：通过当前代理访问 gstatic，返回 HTTP 状态码。 */
export function probeProxy(conf: ProxySettings, timeoutMs = 10_000): Promise<number> {
  const target = new URL("https://www.gstatic.com/generate_204");
  const agent = agentFor(conf, target);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: target.hostname,
        port: 443,
        path: target.pathname,
        method: "GET",
        agent,
        headers: { "user-agent": "TS-JMcomic-Bot/0.2", "accept-encoding": "identity" },
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("timeout", () => req.destroy(new Error("请求超时")));
    req.on("error", reject);
    req.end();
  });
}
