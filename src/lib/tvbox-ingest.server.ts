/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

import { createHash } from 'crypto';

import type { AdminConfig } from './admin.types';
import { fetchSource } from './source-fetch';
import type {
  TVBoxIngestPreview,
  TVBoxIngestSite,
} from './tvbox-ingest.shared';

/** 单次订阅响应体上限，避免异常大文件拖垮运行时 */
const MAX_BODY_BYTES = 12 * 1024 * 1024;
/** 多仓订阅最多展开的仓库数量 */
const MAX_REPOS = 8;

const REQUEST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

function cleanName(raw: unknown, fallback: string): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const stripped = text.replace(/^\s*\[[^\]]*\]\s*/, '').trim();
  return stripped || text || fallback;
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

/**
 * CMS 接口地址统一去掉查询参数：TVBox 里常见 ?ac=list、?ac=videolist 之类的写法，
 * 本站搜索/详情会自己追加参数。
 */
function normalizeApi(raw: unknown): string {
  if (!isHttpUrl(raw)) return '';
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return `${url.origin}${url.pathname}`;
  } catch {
    return '';
  }
}

function isXmlApi(api: string): boolean {
  return /\.xml(?:$|\?)/i.test(api);
}

function buildSourceKey(api: string): string {
  const hash = createHash('sha1')
    .update(api.replace(/\/+$/, '').toLowerCase())
    .digest('hex')
    .slice(0, 12);
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

interface CollectState {
  seen: Map<string, TVBoxIngestSite>;
  totalSites: number;
  duplicates: number;
}

function collectSites(json: any, state: CollectState): void {
  const list = Array.isArray(json?.sites) ? json.sites : [];
  state.totalSites += list.length;

  for (const site of list) {
    if (!site || Number(site.type) !== 1) continue;
    const api = normalizeApi(site.api);
    if (!api || isXmlApi(api)) continue;

    const dedupeKey = api.replace(/\/+$/, '').toLowerCase();
    if (state.seen.has(dedupeKey)) {
      state.duplicates += 1;
      continue;
    }

    state.seen.set(dedupeKey, {
      key: buildSourceKey(api),
      name: cleanName(site.name, api),
      api,
      type: 1,
    });
  }
}

/**
 * 拉取并解析 TVBox 订阅里的 CMS 站点（type=1）。
 * spider 源（type=3/4）需要 TVBox 的 jar 运行环境，无法作为普通接口导入。
 */
export async function fetchTVBoxIngestPreview(
  configUrl: string
): Promise<TVBoxIngestPreview> {
  if (!isHttpUrl(configUrl)) {
    throw new Error('订阅地址必须是 http(s) 链接');
  }

  const root = await fetchSubscriptionJson(configUrl.trim());
  const state: CollectState = {
    seen: new Map(),
    totalSites: 0,
    duplicates: 0,
  };

  collectSites(root, state);

  const repoUrls = Array.isArray(root?.urls)
    ? root.urls
        .filter(isHttpUrl)
        .map((item: string) => item.trim())
        .slice(0, MAX_REPOS)
    : [];

  for (const repoUrl of repoUrls) {
    try {
      const repoJson = await fetchSubscriptionJson(repoUrl);
      collectSites(repoJson, state);
    } catch (error) {
      console.warn(
        `[tvbox-ingest] 仓库解析失败 ${repoUrl}:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  const sites = Array.from(state.seen.values());
  return {
    configUrl: configUrl.trim(),
    totalSites: state.totalSites,
    usableSites: sites.length,
    duplicates: state.duplicates,
    repos: repoUrls.length,
    sites,
  };
}

/**
 * 把订阅里的 CMS 站点写入 SourceConfig，与手动添加的视频源统一管理。
 * 已存在的接口地址或 key 会跳过，避免重复导入。
 */
export async function importTVBoxSources(
  config: AdminConfig,
  configUrl: string,
  selectedKeys?: string[]
): Promise<{ added: number; skipped: number; preview: TVBoxIngestPreview }> {
  const preview = await fetchTVBoxIngestPreview(configUrl);
  const selected =
    Array.isArray(selectedKeys) && selectedKeys.length > 0
      ? new Set(selectedKeys)
      : null;

  if (!config.SourceConfig) {
    config.SourceConfig = [];
  }

  const existingApis = new Set(
    config.SourceConfig.map((item) => item.api.replace(/\/+$/, '').toLowerCase())
  );
  const existingKeys = new Set(config.SourceConfig.map((item) => item.key));

  let added = 0;
  let skipped = 0;

  for (const site of preview.sites) {
    if (selected && !selected.has(site.key)) continue;
    const apiKey = site.api.replace(/\/+$/, '').toLowerCase();
    if (existingApis.has(apiKey) || existingKeys.has(site.key)) {
      skipped += 1;
      continue;
    }
    config.SourceConfig.push({
      key: site.key,
      name: site.name,
      api: site.api,
      detail: site.api,
      from: 'custom',
      disabled: false,
      proxyMode: false,
    });
    existingApis.add(apiKey);
    existingKeys.add(site.key);
    added += 1;
  }

  return { added, skipped, preview };
}
