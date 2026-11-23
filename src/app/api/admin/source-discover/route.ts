/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

import * as cheerio from 'cheerio/slim';
import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getConfig } from '@/lib/config';
import { db } from '@/lib/db';
import { fetchSource } from '@/lib/source-fetch';

export const runtime = 'nodejs';

const FETCH_TIMEOUT_MS = 15000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

async function assertAdmin(request: NextRequest) {
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  if (storageType === 'localstorage') {
    throw new Error('不支持本地存储进行管理员配置');
  }

  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo?.username) {
    return null;
  }

  if (authInfo.username === process.env.USERNAME) {
    return authInfo.username;
  }

  const userInfoV2 = await db.getUserInfoV2(authInfo.username);
  if (
    !userInfoV2 ||
    (userInfoV2.role !== 'admin' && userInfoV2.role !== 'owner') ||
    userInfoV2.banned
  ) {
    return null;
  }

  return authInfo.username;
}

function normalizeInputUrl(raw: string): URL {
  const trimmed = (raw || '').trim();
  if (!trimmed) {
    throw new Error('请输入视频网站地址');
  }

  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const url = new URL(withScheme);

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('仅支持 http/https 网站');
  }

  return url;
}

async function fetchText(url: string, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchSource(
      url,
      {
        headers: {
          'User-Agent': UA,
          Accept: 'application/json,text/html,*/*',
        },
        signal: controller.signal,
      },
      { directTimeoutMs: 8000, relayTimeoutMs: timeoutMs }
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return { text: await response.text(), finalUrl: response.url || url };
  } finally {
    clearTimeout(timer);
  }
}

function safeParseJson(text: string): any | null {
  const cleaned = text.replace(/^\uFEFF/, '').trim();
  if (!cleaned) return null;
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function appendQuery(base: string, query: string) {
  return `${base}${base.includes('?') ? '&' : '?'}${query}`;
}

/** 从站点首页 HTML 里找线索：标题、页面里直接暴露的采集接口 */
async function inspectHomepage(siteUrl: URL) {
  const result = {
    title: '',
    apiHints: [] as string[],
  };

  try {
    const { text, finalUrl } = await fetchText(siteUrl.toString());
    const final = new URL(finalUrl || siteUrl.toString());

    const $ = cheerio.load(text);
    const siteName = $('meta[property="og:site_name"]').attr('content') || '';
    const title = $('title').first().text() || '';
    result.title = (siteName || title).trim();

    // 页面里直接写死的采集接口（相对/绝对都可能有）
    const matches =
      text.match(
        /(?:https?:\/\/[^\s"'<>]+)?\/?api\.php\/provide\/vod\/?(?:at\/[a-z]+\/)?/gi
      ) || [];
    for (const raw of matches) {
      const candidate = raw.startsWith('http')
        ? raw
        : `${final.origin}${raw.startsWith('/') ? '' : '/'}${raw}`;
      try {
        result.apiHints.push(new URL(candidate).toString());
      } catch {
        // 忽略拼不出来的线索
      }
    }
  } catch (error) {
    console.warn('[source-discover] 抓取首页失败:', (error as Error).message);
  }

  return result;
}

function buildApiCandidates(siteUrl: URL, hints: string[]): string[] {
  const origin = siteUrl.origin;
  const candidates: string[] = [];

  const path = siteUrl.pathname || '/';
  if (/api\.php|provide\/vod|\/api\/|ajax/i.test(path) && path !== '/') {
    const direct = `${origin}${path}`.replace(/[?#].*$/, '');
    candidates.push(direct.endsWith('/') ? direct : `${direct}/`);
  }

  for (const hint of hints) {
    candidates.push(hint);
  }

  const knownPaths = [
    '/api.php/provide/vod/',
    '/api.php/provide/vod/at/json/',
    '/api.php/provide/vod/at/xml/',
    '/api.php/provide/vod',
    '/provide/vod/',
    '/index.php/api/vod/',
    '/api/vod/',
  ];
  for (const item of knownPaths) {
    candidates.push(`${origin}${item}`);
  }

  return Array.from(
    new Set(
      candidates.map((item) => {
        const noQuery = item.replace(/[?#].*$/, '');
        return noQuery.endsWith('/') || noQuery.endsWith('api.php/provide/vod')
          ? noQuery
          : `${noQuery}/`;
      })
    )
  );
}

interface CmsProbeResult {
  api: string;
  total: number;
  pagecount: number;
  sample: Array<{
    id: string;
    name: string;
    type_name: string;
    remarks: string;
  }>;
}

async function probeCms(apiBase: string): Promise<CmsProbeResult | null> {
  try {
    const { text } = await fetchText(appendQuery(apiBase, 'ac=list'), 8000);
    const json = safeParseJson(text);
    if (!json || !Array.isArray(json.list)) {
      return null;
    }

    const code = Number(json.code);
    if (code !== 1 && code !== 200) {
      return null;
    }

    const list = json.list as any[];
    // 至少要有一条带 vod_id / vod_name 的数据，避免把普通 JSON 误判成采集接口
    const looksLikeCms = list.some(
      (item) => item && (item.vod_id !== undefined || item.vod_name !== undefined)
    );
    if (!looksLikeCms) {
      return null;
    }

    return {
      api: apiBase,
      total: Number(json.total) || list.length,
      pagecount: Number(json.pagecount) || 1,
      sample: list.slice(0, 6).map((item) => ({
        id: String(item.vod_id ?? ''),
        name: String(item.vod_name ?? ''),
        type_name: String(item.type_name ?? ''),
        remarks: String(item.vod_remarks ?? ''),
      })),
    };
  } catch (error) {
    console.warn(
      `[source-discover] 探测失败 ${apiBase}:`,
      (error as Error).message
    );
    return null;
  }
}

function cleanSiteName(rawTitle: string, hostname: string) {
  const compact = (rawTitle || '').replace(/\s+/g, ' ').trim();
  if (!compact) {
    // 首页抓不到标题时（例如被防护页拦截），退化为域名主体，避免出现 www. 前缀
    const host = hostname.replace(/^www\./i, '');
    return host.split('.')[0] || host;
  }

  const firstSegment = compact.split(/[-_|｜—–·]/)[0].trim();
  const name = firstSegment.length >= 2 ? firstSegment : compact;
  return name.slice(0, 30);
}

function buildSourceKey(hostname: string, existingKeys: Set<string>) {
  const label = hostname
    .replace(/^www\./i, '')
    .split('.')[0]
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
  const base = label || `site${Date.now().toString(36).slice(-5)}`;

  const reserved = (key: string) =>
    key === 'openlist' ||
    key === 'xiaoya' ||
    key.startsWith('emby') ||
    key.startsWith('tvbox:');

  let candidate = base;
  let suffix = 2;
  while (existingKeys.has(candidate) || reserved(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export async function POST(request: NextRequest) {
  try {
    const username = await assertAdmin(request);
    if (!username) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await request.json().catch(() => ({}))) as { url?: string };
    const siteUrl = normalizeInputUrl(body.url || '');

    const homepage = await inspectHomepage(siteUrl);
    const candidates = buildApiCandidates(siteUrl, homepage.apiHints).slice(0, 8);

    // 并行探测全部候选接口，取第一个有效结果，避免串行等待拖慢整体耗时
    const probed = await Promise.all(
      candidates.map((candidate) =>
        probeCms(candidate).catch(() => null)
      )
    );
    const matched = probed.find((item): item is CmsProbeResult => !!item) || null;

    if (!matched) {
      return NextResponse.json(
        {
          error:
            '未检测到可用的采集接口。请确认该网站是苹果CMS等支持的采集站（通常提供 /api.php/provide/vod/）。',
        },
        { status: 422 }
      );
    }

    const adminConfig = await getConfig();
    const existingKeys = new Set(adminConfig.SourceConfig.map((item) => item.key));
    const key = buildSourceKey(siteUrl.hostname, existingKeys);
    const name = cleanSiteName(homepage.title, siteUrl.hostname);

    return NextResponse.json(
      {
        ok: true,
        site: {
          url: siteUrl.origin,
          title: homepage.title,
          hostname: siteUrl.hostname,
        },
        // 与视频源配置格式一致，可直接导入
        source: {
          key,
          name,
          api: matched.api,
          detail: '',
        },
        stats: {
          total: matched.total,
          pagecount: matched.pagecount,
        },
        sample: matched.sample,
      },
      {
        headers: {
          'Cache-Control': 'no-store',
        },
      }
    );
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message || '资源获取失败' },
      { status: 500 }
    );
  }
}
