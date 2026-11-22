/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

import { createHash } from 'crypto';

import type { AdminConfig } from './admin.types';
import { fetchSource } from './source-fetch';
import type {
  TVBoxLiveIngestItem,
  TVBoxLiveIngestPreview,
} from './tvbox-live-ingest.shared';

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
 * TVBox 里 127.0.0.1 / localhost 的 /proxy 地址依赖 TVBox 客户端自身的代理，
 * 导入到本站后没有任何服务能响应，必须跳过。
 */
function isLocalProxyUrl(url: string): boolean {
  if (/^\//.test(url)) return true;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return (
      /^127\./.test(host) ||
      ['localhost', '0.0.0.0', '[::1]'].includes(host)
    );
  } catch {
    return false;
  }
}

function buildLiveKey(url: string): string {
  const hash = createHash('sha1').update(url).digest('hex').slice(0, 12);
  return `tvbox-live_${hash}`;
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
  seen: Map<string, TVBoxLiveIngestItem>;
  totalLives: number;
  duplicates: number;
  skippedLocal: number;
}

function collectLives(json: any, state: CollectState): void {
  const list = Array.isArray(json?.lives) ? json.lives : [];
  state.totalLives += list.length;

  for (const live of list) {
    if (!live) continue;
    const rawUrl = typeof live.url === 'string' ? live.url.trim() : '';
    if (!rawUrl || !isHttpUrl(rawUrl)) {
      // 内嵌 channels 或依赖本机代理的源，需要 TVBox 环境，直接跳过
      state.skippedLocal += 1;
      continue;
    }
    if (isLocalProxyUrl(rawUrl)) {
      state.skippedLocal += 1;
      continue;
    }
    if (state.seen.has(rawUrl)) {
      state.duplicates += 1;
      continue;
    }
    state.seen.set(rawUrl, {
      key: buildLiveKey(rawUrl),
      name: cleanName(live.name, rawUrl),
      url: rawUrl,
      ua: typeof live.ua === 'string' && live.ua.trim() ? live.ua.trim() : undefined,
      epg:
        typeof live.epg === 'string' && live.epg.trim()
          ? live.epg.trim()
          : undefined,
      type: Number(live.type) === 1 ? 1 : 0,
    });
  }
}

/**
 * 拉取并解析 TVBox 订阅里的直播源（lives）。
 * 只保留可以直接访问的 http(s) 直播列表地址；内嵌频道和本机代理源会跳过。
 */
export async function fetchTVBoxLiveIngestPreview(
  configUrl: string
): Promise<TVBoxLiveIngestPreview> {
  if (!isHttpUrl(configUrl)) {
    throw new Error('订阅地址必须是 http(s) 链接');
  }

  const root = await fetchSubscriptionJson(configUrl.trim());
  const state: CollectState = {
    seen: new Map(),
    totalLives: 0,
    duplicates: 0,
    skippedLocal: 0,
  };

  collectLives(root, state);

  const repoUrls = Array.isArray(root?.urls)
    ? root.urls
        .filter(isHttpUrl)
        .map((item: string) => item.trim())
        .slice(0, MAX_REPOS)
    : [];

  for (const repoUrl of repoUrls) {
    try {
      const repoJson = await fetchSubscriptionJson(repoUrl);
      collectLives(repoJson, state);
    } catch (error) {
      console.warn(
        `[tvbox-live-ingest] 仓库解析失败 ${repoUrl}:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  const items = Array.from(state.seen.values());
  return {
    configUrl: configUrl.trim(),
    totalLives: state.totalLives,
    usableLives: items.length,
    duplicates: state.duplicates,
    skippedLocal: state.skippedLocal,
    repos: repoUrls.length,
    items,
  };
}

/**
 * 把订阅里的直播源写入 LiveConfig，与手动添加的电视源统一管理。
 * 已存在的地址或 key 会跳过，避免重复导入。
 */
export async function importTVBoxLiveSources(
  config: AdminConfig,
  configUrl: string,
  selectedKeys?: string[]
): Promise<{ added: number; skipped: number; preview: TVBoxLiveIngestPreview }> {
  const preview = await fetchTVBoxLiveIngestPreview(configUrl);
  const selected =
    Array.isArray(selectedKeys) && selectedKeys.length > 0
      ? new Set(selectedKeys)
      : null;

  if (!config.LiveConfig) {
    config.LiveConfig = [];
  }

  const existingUrls = new Set(config.LiveConfig.map((item) => item.url));
  const existingKeys = new Set(config.LiveConfig.map((item) => item.key));

  let added = 0;
  let skipped = 0;

  for (const item of preview.items) {
    if (selected && !selected.has(item.key)) continue;
    if (existingUrls.has(item.url) || existingKeys.has(item.key)) {
      skipped += 1;
      continue;
    }
    config.LiveConfig.push({
      key: item.key,
      name: item.name,
      url: item.url,
      ua: item.ua || '',
      epg: item.epg || '',
      from: 'custom',
      channelNumber: 0,
      disabled: false,
    });
    existingUrls.add(item.url);
    existingKeys.add(item.key);
    added += 1;
  }

  return { added, skipped, preview };
}
