// SPDX-License-Identifier: MIT

import { encodeKeyPath, sha256Hex, signV4, uriEncode } from "./sigv4.js";
import type { StorageAdapter, StoredObject } from "./storage-adapter.js";

export interface S3AdapterOptions {
  bucket: string;
  region: string;
  endpoint?: string | undefined;
  accessKeyId: string;
  secretAccessKey: string;
  /** Temporary-credential token (STS), when used. */
  sessionToken?: string | undefined;
  /**
   * Address the bucket as `<endpoint>/<bucket>/<key>` instead of
   * `<bucket>.<endpoint>/<key>`. Defaults to true with a custom endpoint
   * (MinIO, R2, most S3-compatibles) and false for AWS itself.
   */
  forcePathStyle?: boolean | undefined;
  /** Public CDN base URL (optional — falls back to s3 endpoint) */
  cdnBaseUrl?: string | undefined;
  /** Injected for tests. */
  fetch?: typeof fetch;
}

/** Raw response for streaming a stored object to a client. */
export interface S3ObjectResponse {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

/**
 * S3-compatible storage adapter (AWS S3, Cloudflare R2, MinIO, …), signed with
 * AWS Signature V4 over the native fetch API — no AWS SDK required.
 */
export class S3StorageAdapter implements StorageAdapter {
  private readonly endpoint: URL;
  private readonly pathStyle: boolean;
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: S3AdapterOptions) {
    this.endpoint = new URL(
      opts.endpoint ? opts.endpoint.replace(/\/$/, "") : `https://s3.${opts.region}.amazonaws.com`,
    );
    this.pathStyle = opts.forcePathStyle ?? Boolean(opts.endpoint);
    this.doFetch = opts.fetch ?? fetch;
  }

  /** Request URL for a key (or the bucket root when key is empty). */
  objectUrl(key: string, query?: Record<string, string>): URL {
    const base = new URL(this.endpoint.toString());
    const encoded = key ? encodeKeyPath(key) : "";
    if (this.pathStyle) {
      base.pathname = `${base.pathname.replace(/\/$/, "")}/${uriEncode(this.opts.bucket)}/${encoded}`;
    } else {
      base.hostname = `${this.opts.bucket}.${base.hostname}`;
      base.pathname = `/${encoded}`;
    }
    for (const [k, v] of Object.entries(query ?? {})) base.searchParams.set(k, v);
    return base;
  }

  private async request(
    method: string,
    url: URL,
    opts: {
      body?: Buffer;
      headers?: Record<string, string>;
      unsigned?: Record<string, string>;
    } = {},
  ): Promise<Response> {
    const signed = signV4(
      {
        method,
        url,
        headers: opts.headers,
        payloadHash: opts.body ? sha256Hex(opts.body) : undefined,
        region: this.opts.region,
      },
      {
        accessKeyId: this.opts.accessKeyId,
        secretAccessKey: this.opts.secretAccessKey,
        sessionToken: this.opts.sessionToken,
      },
    );
    // `host` is set by fetch from the URL; sending it explicitly is refused.
    const { host: _host, ...headers } = signed;
    const init: RequestInit = { method, headers: { ...headers, ...(opts.unsigned ?? {}) } };
    if (opts.body) init.body = new Uint8Array(opts.body);
    return this.doFetch(url, init);
  }

  private async fail(op: string, key: string, res: Response): Promise<never> {
    const text = await res.text().catch(() => "");
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
    throw new Error(
      `S3 ${op} ${key} failed: ${res.status}${code ? ` ${code}` : ` ${res.statusText}`}`,
    );
  }

  async save(key: string, data: Buffer, mimeType: string, cacheControl?: string): Promise<string> {
    const res = await this.request("PUT", this.objectUrl(key), {
      body: data,
      headers: {
        "content-type": mimeType || "application/octet-stream",
        ...(cacheControl ? { "cache-control": cacheControl } : {}),
      },
    });
    if (!res.ok) await this.fail("PUT", key, res);
    return this.url(key);
  }

  async delete(key: string): Promise<void> {
    const res = await this.request("DELETE", this.objectUrl(key));
    if (!res.ok && res.status !== 404) await this.fail("DELETE", key, res);
  }

  url(key: string): string {
    if (this.opts.cdnBaseUrl) {
      return `${this.opts.cdnBaseUrl.replace(/\/$/, "")}/${encodeKeyPath(key)}`;
    }
    return this.objectUrl(key).toString();
  }

  async read(key: string): Promise<StoredObject | null> {
    const res = await this.request("GET", this.objectUrl(key));
    if (res.status === 404) return null;
    if (!res.ok) await this.fail("GET", key, res);
    return {
      body: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get("content-type"),
    };
  }

  /**
   * GET for streaming to a client. Conditional and range headers are passed
   * through unsigned so 304 / 206 responses work.
   */
  async open(key: string, passthrough: Record<string, string> = {}): Promise<S3ObjectResponse> {
    const res = await this.request("GET", this.objectUrl(key), { unsigned: passthrough });
    return { status: res.status, headers: res.headers, body: res.body };
  }

  async exists(key: string): Promise<boolean> {
    const res = await this.request("HEAD", this.objectUrl(key));
    if (res.status === 404) return false;
    if (!res.ok) await this.fail("HEAD", key, res);
    return true;
  }

  async move(from: string, to: string): Promise<boolean> {
    // A "folder" (prefix) moves object by object.
    if (from.endsWith("/")) {
      const keys = await this.list(from);
      if (keys.length === 0) return false;
      await this.deletePrefix(to);
      for (const key of keys) await this.copyThenDelete(key, to + key.slice(from.length));
      return true;
    }
    return this.copyThenDelete(from, to);
  }

  private async copyThenDelete(from: string, to: string): Promise<boolean> {
    const source = `/${this.opts.bucket}/${encodeKeyPath(from)}`;
    const res = await this.request("PUT", this.objectUrl(to), {
      headers: { "x-amz-copy-source": source },
    });
    if (res.status === 404) return false;
    // CopyObject can answer 200 with an <Error> body.
    const text = await res.text();
    if (!res.ok || /<Error>/.test(text)) {
      const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
      if (code === "NoSuchKey") return false;
      throw new Error(`S3 COPY ${from} → ${to} failed: ${res.status}${code ? ` ${code}` : ""}`);
    }
    await this.delete(from);
    return true;
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const query: Record<string, string> = { "list-type": "2", prefix };
      if (token) query["continuation-token"] = token;
      const res = await this.request("GET", this.objectUrl("", query));
      if (!res.ok) await this.fail("LIST", prefix, res);
      const xml = await res.text();
      for (const match of xml.matchAll(
        /<Contents>[\s\S]*?<Key>([^<]*)<\/Key>[\s\S]*?<\/Contents>/g,
      )) {
        keys.push(decodeXml(match[1]!));
      }
      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      const next = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1];
      token = truncated && next ? decodeXml(next) : undefined;
    } while (token);
    return keys.sort();
  }

  async deletePrefix(prefix: string): Promise<void> {
    for (const key of await this.list(prefix)) await this.delete(key);
  }
}
