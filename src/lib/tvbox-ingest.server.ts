/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

import { createHash } from 'crypto';

import type { AdminConfig } from './admin.types';
import { fetchSource } from './source-fetch';
import type { TVBoxIngestPreview, TVBoxIngestSite } from './tvbox-ingest.shared';

/** 单次订阅响应体上限，避免异常大文件拖垮运行时 */
const MAX_BODY_BYTES = 12 * 1024 * 1024;
/** 多仓订阅最多展开的仓库数量 */
const MAX_REPOS = 8;

const REQUEST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

function normalizeApi(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    // TVBox 的 api 常带 ?ac=list 之类的参数，本站拼接 ?ac=videolist 时会冲突
    url.search = '';
    url.hash = '';
    // XML 接口本站无法解析，直接跳过
    if (/\/xml\/?$/i.test(url.pathname)) return null;
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

function cleanName(raw: unknown, fallback: string): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  // 去掉 TVBox 常见的速度/线路前缀，例如 "[79ms|vv] 影视"
  const stripped = text.replace(/^\s*\[[^\]]*\]\s*/, '').trim();
  return stripped || text || fallback;
}

function buildSourceKey(api: string): string {
  const hash = createHash('sha1').update(api).digest('hex').slice(0, 12);
  return `tvbox_${hash}`;
}

async function fetchSubscriptionJson(url: string): Promise<any> {
  const response = await fetchSource(
    url,
    {
      headers: REQUEST_HEADERS,
      signal: AbortSignal.timeout(40000),
    },
    { directTimeoutMs: 5000, relayTimeoutMs: 20000 }
  );
  if (!response.ok) {
    throw new Error(`订阅请求失败：HTTP ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_BODY_BYTES) {
    throw new Error('订阅内容过大，已停止解析');
  }
  const text = new TextDecoder('utf-8')
    .decode(buffer)
    .replace(/^\uFEFF/, '');
  return JSON.parse(text);
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

/**
 * 拉取并解析 TVBox 订阅，只保留 type=1 的 CMS 站点。
 * 多仓订阅（顶层 urls）会展开一层，合并各仓库的站点。
 */
export async function fetchTVBoxIngestPreview(
  configUrl: string
): Promise<TVBoxIngestPreview> {
  if (!isHttpUrl(configUrl)) {
    throw new Error('订阅地址必须是 http(s) 链接');
  }

  const root = await fetchSubscriptionJson(configUrl.trim());
  const seen = new Map<string, TVBoxIngestSite>();
  let totalSites = 0;
  let duplicates = 0;

  const collect = (json: any, sourceUrl: string) => {
    const list = Array.isArray(json?.sites) ? json.sites : [];
    totalSites += list.length;
    for (const site of list) {
      if (!site || Number(site.type) !== 1) continue;
      const api = normalizeApi(site.api);
      if (!api) continue;
      if (seen.has(api)) {
        duplicates += 1;
        continue;
      }
      seen.set(api, {
        key: buildSourceKey(api),
        name: cleanName(site.name, String(site.key || api)),
        api,
        siteKey: typeof site.key === 'string' ? site.key : '',
        sourceUrl,
      });
    }
  };

  collect(root, configUrl.trim());

  const repoUrls = Array.isArray(root?.urls)
    ? root.urls
        .filter(isHttpUrl)
        .map((item: string) => item.trim())
        .slice(0, MAX_REPOS)
    : [];

  for (const repoUrl of repoUrls) {
    try {
      const repoJson = await fetchSubscriptionJson(repoUrl);
      collect(repoJson, repoUrl);
    } catch (error) {
      console.warn(
        `[tvbox-ingest] 仓库解析失败 ${repoUrl}:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  const sites = Array.from(seen.values());
  return {
    configUrl: configUrl.trim(),
    totalSites,
    usableSites: sites.length,
    duplicates,
    repos: repoUrls.length,
    sites,
  };
}

/**
 * 把订阅中的 CMS 站点写入 SourceConfig，与普通视频源统一管理。
 * 已存在的 API 或 key 会被跳过，避免重复导入。
 */
export async function importTVBoxIngestSites(
  config: AdminConfig,
  configUrl: string,
  selectedKeys?: string[]
): Promise<{ added: number; skipped: number; preview: TVBoxIngestPreview }> {
  const preview = await fetchTVBoxIngestPreview(configUrl);
  const selected =
    Array.isArray(selectedKeys) && selectedKeys.length > 0
      ? new Set(selectedKeys)
      : null;

  const existingApis = new Set(
    config.SourceConfig.map((source) => normalizeApi(source.api) || source.api)
  );
  const existingKeys = new Set(config.SourceConfig.map((source) => source.key));

  let added = 0;
  let skipped = 0;

  for (const site of preview.sites) {
    if (selected && !selected.has(site.key)) continue;
    if (existingApis.has(site.api) || existingKeys.has(site.key)) {
      skipped += 1;
      continue;
    }
    config.SourceConfig.push({
      key: site.key,
      name: site.name,
      api: site.api,
      from: 'custom',
      disabled: false,
      proxyMode: false,
      weight: 0,
      tvbox: {
        configUrl: preview.configUrl,
        siteKey: site.siteKey,
        sourceUrl: site.sourceUrl,
      },
    });
    existingApis.add(site.api);
    existingKeys.add(site.key);
    added += 1;
  }

  return { added, skipped, preview };
}
