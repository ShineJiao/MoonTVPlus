/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

import type { GuomanItem } from './types';

type Platform = 'bilibili' | 'tencent' | 'youku';

const PLATFORM_CN: Record<Platform, string> = {
  bilibili: 'B站国创',
  tencent: '腾讯视频',
  youku: '优酷动漫',
};

const WEEK_CN = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

interface RawShow {
  platform: Platform;
  title: string;
  weekday: number;
  pubTime: string;
  latest: string;
  rule: string;
  cover: string;
  poster: string;
  sourceUrl: string;
}

const WEEK_PATTERNS = [
  /每\s*周\s*([一二三四五六日天1-7])/,
  /周\s*([一二三四五六日天1-7])\s*(?:\d{1,2}\s*[:：]\s*\d{2}|\d{1,2}\s*点)?\s*(?:更新|上线|更|开播|播出|放送)/,
];

const CN2NUM: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 7,
  天: 7,
  '1': 1,
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 7,
};

const COVER_PATTERNS = [
  /smallCoverPic\s*:\s*"([^"]+)"/g,
  /coverPic\s*:\s*"([^"]+)"/g,
  /"(?:cover|image|poster|pic)"\s*:\s*"([^"]+)"/g,
];

function unescapeHtml(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function normalizeTitle(title: string): string {
  return title.replace(/[\s·:：\-—_（）()]+/g, '').toLowerCase();
}

function normalizeCover(url: string): string {
  let value = unescapeHtml(url.trim().replace(/^"|"$/g, ''));
  value = value.replace(/\\u002F/g, '/').replace(/\\\//g, '/');
  if (value.startsWith('//')) {
    value = `https:${value}`;
  } else if (
    value.startsWith('http://') &&
    (value.includes('hdslb.com') || value.includes('qpic.cn'))
  ) {
    value = `https://${value.slice(7)}`;
  }
  return /^https?:\/\//.test(value) ? value : '';
}

function parseRule(text: string): {
  weekday: number | null;
  pubTime: string;
  latest: string;
  rule: string;
} {
  if (!text) return { weekday: null, pubTime: '', latest: '', rule: '' };
  let weekday: number | null = null;
  let rule = '';
  for (const pattern of WEEK_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      weekday = CN2NUM[match[1]] || null;
      rule = text
        .slice(Math.max(0, (match.index || 0) - 16), (match.index || 0) + match[0].length + 36)
        .replace(/^[\s,，{}:"']+|[\s,，{}:"']+$/g, '');
      break;
    }
  }
  const timeMatch = text.match(/(\d{1,2})[:：](\d{2})/);
  const hourMatch = text.match(/(\d{1,2})\s*点/);
  const pubTime = timeMatch
    ? `${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}`
    : hourMatch
      ? `${hourMatch[1].padStart(2, '0')}:00`
      : '';
  const episodeMatch = text.match(/更新至\s*(\d+)\s*[集话期]/);
  return {
    weekday,
    pubTime,
    latest: episodeMatch ? `更新至${episodeMatch[1]}集` : '',
    rule,
  };
}

function extractCover(context: string): string {
  for (const pattern of COVER_PATTERNS) {
    pattern.lastIndex = 0;
    const hits = Array.from(context.matchAll(pattern));
    if (hits.length > 0) {
      const url = normalizeCover(hits[hits.length - 1][1] || '');
      if (url) return url;
    }
  }
  return '';
}

async function fetchTextOrJson(
  url: string,
  asJson: boolean,
  referer: string,
  timeoutMs = 6000
): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: referer,
      },
    });
    if (!response.ok) return null;
    return asJson ? await response.json() : await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function makeRawShow(
  platform: Platform,
  title: string,
  weekday: number,
  parsed: { pubTime: string; latest: string; rule: string },
  cover: string,
  sourceUrl: string
): RawShow {
  const pubTime = parsed.pubTime;
  return {
    platform,
    title,
    weekday,
    pubTime,
    latest: parsed.latest,
    rule: parsed.rule || `${WEEK_CN[weekday]}${pubTime ? ` ${pubTime}` : ''}`,
    cover: normalizeCover(cover),
    poster: '',
    sourceUrl,
  };
}

async function fetchBilibili(): Promise<RawShow[]> {
  const referer = 'https://www.bilibili.com/';
  const shows = new Map<string, RawShow>();

  const timeline = await fetchTextOrJson(
    'https://api.bilibili.com/pgc/web/timeline?types=4&before=6&after=6',
    true,
    referer
  );
  if (timeline && timeline.code === 0) {
    for (const day of timeline.result || []) {
      const weekday = Number(day?.day_of_week);
      if (!(weekday >= 1 && weekday <= 7)) continue;
      for (const episode of day?.episodes || []) {
        const title = String(episode?.title || '').trim();
        if (!title) continue;
        const pubTime = String(episode?.pub_time || '').slice(0, 5);
        const item = makeRawShow(
          'bilibili',
          title,
          weekday,
          {
            pubTime,
            latest: String(episode?.pub_index || ''),
            rule: '',
          },
          String(episode?.square_cover || episode?.cover || ''),
          episode?.season_id
            ? `https://www.bilibili.com/bangumi/play/ss${episode.season_id}`
            : referer
        );
        shows.set(`${item.platform}|${normalizeTitle(title)}`, item);
      }
    }
  }

  // 国创「连载中」索引：只用于补全最新集数与封面，索引本身没有星期，不新增条目
  const index = await fetchTextOrJson(
    'https://api.bilibili.com/pgc/season/index/result?season_type=4&type=1&is_finish=0&order=0&sort=0&st=4&page=1&pagesize=50',
    true,
    referer
  );
  if (index && index.code === 0) {
    for (const entry of index?.data?.list || []) {
      const title = String(entry?.title || '').trim();
      if (!title) continue;
      const current = shows.get(`bilibili|${normalizeTitle(title)}`);
      if (!current) continue;
      current.latest =
        current.latest || String(entry?.index_show || entry?.pub_index || '');
      current.cover =
        current.cover || normalizeCover(String(entry?.cover || ''));
    }
  }

  return Array.from(shows.values());
}

async function fetchPageShows(
  platform: Platform,
  url: string,
  patterns: RegExp[]
): Promise<RawShow[]> {
  const text = await fetchTextOrJson(url, false, url);
  if (!text) return [];

  const found = new Map<string, RawShow>();
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const title = unescapeHtml((match[1] || '').trim());
      if (title.length < 2 || title.length > 30) continue;
      if (!/[\u4e00-\u9fa5A-Za-z]/.test(title)) continue;

      const start = match.index;
      const end = start + match[0].length;
      const parsed = parseRule(text.slice(Math.max(0, start - 200), end + 600));
      // 拿不到明确星期的条目直接丢弃，不进入结果
      if (!parsed.weekday) continue;

      const cover = extractCover(
        text.slice(Math.max(0, start - 1200), end + 200)
      );
      const item = makeRawShow(
        platform,
        title,
        parsed.weekday,
        parsed,
        cover,
        url
      );
      found.set(`${platform}|${normalizeTitle(title)}`, item);
    }
  }
  return Array.from(found.values());
}

function fetchTencent(): Promise<RawShow[]> {
  return fetchPageShows(
    'tencent',
    'https://v.qq.com/channel/cartoon?channel_2022=1&istate=2&itype=4&iarea=16&offset=0&sort=19',
    [/mzTitle\s*:\s*"([^"]+)"/g, /"title"\s*:\s*"([^"]{2,30})"/g]
  );
}

function fetchYouku(): Promise<RawShow[]> {
  return fetchPageShows('youku', 'https://youku.com/channel/webcomic/list', [
    /"title"\s*:\s*"([^"]{2,30})"/g,
    /name\s*:\s*"([^"]{2,30})"/g,
  ]);
}

const posterCache = new Map<string, { poster: string; at: number }>();
const POSTER_CACHE_TTL = 6 * 60 * 60 * 1000;
// 移动端搜索接口可按同名检索豆瓣条目，返回带封面的结果
const DOUBAN_SEARCH_ENDPOINT =
  'https://m.douban.com/rexxar/api/v2/search/subjects';
const DOUBAN_MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
// 豆瓣接口在服务器直连时容易被风控，subject_suggest 作为兜底镜像
const DOUBAN_SUGGEST_ENDPOINTS = [
  'https://movie.douban.cmliussss.com/j/subject_suggest',
  'https://movie.douban.cmliussss.net/j/subject_suggest',
  'https://movie.douban.com/j/subject_suggest',
];

interface DoubanSuggestItem {
  title?: string;
  img?: string;
  type?: string;
}

interface DoubanSearchTarget {
  title?: string;
  cover_url?: string;
  card_subtitle?: string;
}

async function requestDoubanSearch(
  title: string,
  timeoutMs: number
): Promise<DoubanSearchTarget[] | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(
        `${DOUBAN_SEARCH_ENDPOINT}?q=${encodeURIComponent(
          title
        )}&type=movie&sort=relevance`,
        {
          signal: controller.signal,
          cache: 'no-store',
          headers: {
            'User-Agent': DOUBAN_MOBILE_UA,
            Referer: 'https://m.douban.com/',
            Accept: 'application/json, text/plain, */*',
          },
        }
      );
      if (!response.ok) return null;
      const data = (await response.json()) as {
        subjects?: { items?: Array<{ target?: DoubanSearchTarget }> };
      };
      const items = data?.subjects?.items;
      if (!Array.isArray(items)) return null;
      const targets = items
        .map((item) => item.target)
        .filter((target): target is DoubanSearchTarget => !!target?.title);
      // 偶发空结果多为限流，稍后重试一次
      if (targets.length > 0 || attempt === 1) return targets;
      await new Promise((resolve) => setTimeout(resolve, 350));
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

async function requestDoubanSuggest(
  endpoint: string,
  title: string,
  timeoutMs: number
): Promise<DoubanSuggestItem[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `${endpoint}?q=${encodeURIComponent(title)}`,
      {
        signal: controller.signal,
        cache: 'no-store',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
          Referer: 'https://movie.douban.com/',
          Accept: 'application/json, text/plain, */*',
        },
      }
    );
    if (!response.ok) return null;
    const data = (await response.json()) as DoubanSuggestItem[];
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function simplifyTitle(title: string): string {
  return title
    .replace(
      /\s*(第[一二三四五六七八九十\d]+季|年番\s*\d*|最终季|剧场版|篇)\s*$/g,
      ''
    )
    .replace(/\s*[ⅠⅡⅢⅣⅤ]/g, '')
    .trim();
}

function matchKey(title: string): string {
  return normalizeTitle(title).replace(/[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]/g, '');
}

// 豆瓣无封面时会返回占位图，不能当作有效海报
function isPlaceholderPoster(url: string): boolean {
  return (
    !url ||
    url.includes('/f/frodo/') ||
    /\/pics\/subject\/[a-z_]+_normal\.(png|jpg|jpeg|webp)$/i.test(url)
  );
}

// 移动端返回的是带签名的临时图床链接，转成稳定的豆瓣图片地址
function toStablePosterUrl(url: string): string {
  const matched = url.match(
    /\/view\/photo\/(?:large|raw|small|s_ratio_poster|photo)\/public\/(p\d+\.(?:jpg|jpeg|png|webp))/i
  );
  if (matched) {
    return `https://img3.doubanio.com/view/photo/s_ratio_poster/public/${matched[1]}`;
  }
  return url.replace(/^http:\/\//, 'https://');
}

function pickSearchPoster(
  targets: DoubanSearchTarget[],
  query: string
): string {
  const key = matchKey(query);
  const candidates = targets.filter((target) => {
    const cover = target.cover_url || '';
    if (isPlaceholderPoster(cover)) return false;
    const targetKey = matchKey(target.title || '');
    return targetKey === key || targetKey.startsWith(key);
  });
  if (!candidates.length) return '';

  candidates.sort((a, b) => {
    const exact =
      Number(matchKey(b.title || '') === key) -
      Number(matchKey(a.title || '') === key);
    if (exact) return exact;
    // 同名系列优先取动画条目，避免匹配到真人剧
    return (
      Number((b.card_subtitle || '').includes('动画')) -
      Number((a.card_subtitle || '').includes('动画'))
    );
  });
  return toStablePosterUrl(candidates[0].cover_url || '');
}

async function findDoubanPoster(
  query: string,
  deadline: number
): Promise<string> {
  const variants = [query];
  const simplified = simplifyTitle(query);
  if (simplified && simplified !== query) variants.push(simplified);

  let networkFailed = false;
  for (const variant of variants) {
    const remaining = deadline - Date.now();
    if (remaining < 800) break;
    const targets = await requestDoubanSearch(
      variant,
      Math.min(4000, remaining)
    );
    if (!targets) {
      networkFailed = true;
      continue;
    }
    const poster = pickSearchPoster(targets, variant);
    if (poster) return poster;
  }

  // 搜索接口不可用时，兜底走 subject_suggest 镜像
  if (!networkFailed) return '';
  const normalized = matchKey(query);
  for (let attempt = 0; attempt < 2; attempt++) {
    const left = deadline - Date.now();
    if (left < 500) break;
    const endpoint =
      DOUBAN_SUGGEST_ENDPOINTS[attempt % DOUBAN_SUGGEST_ENDPOINTS.length];
    const candidates = await requestDoubanSuggest(
      endpoint,
      query,
      Math.min(2500, left)
    );
    if (!candidates) continue;
    const preferred =
      candidates.find((item) => matchKey(item.title || '') === normalized) ||
      candidates.find((item) =>
        matchKey(item.title || '').startsWith(normalized)
      );
    if (preferred?.img && !isPlaceholderPoster(preferred.img)) {
      return preferred.img.replace(/^http:\/\//, 'https://');
    }
    if (candidates.length > 0) break;
  }
  return '';
}

async function resolveDoubanPoster(
  title: string,
  deadline: number
): Promise<string> {
  const cached = posterCache.get(title);
  if (cached && Date.now() - cached.at < POSTER_CACHE_TTL) {
    return cached.poster;
  }

  let poster = await findDoubanPoster(title, deadline);
  const simplified = simplifyTitle(title);
  if (!poster && simplified && simplified !== title && deadline - Date.now() > 500) {
    poster = await findDoubanPoster(simplified, deadline);
  }

  // 只缓存成功结果，失败的下一轮还能重试
  if (poster) {
    posterCache.set(title, { poster, at: Date.now() });
  }
  return poster;
}

async function enrichPosters(items: RawShow[]): Promise<void> {
  const deadline = Date.now() + 20000;
  let cursor = 0;
  const worker = async (index: number) => {
    // 轻微错峰，降低豆瓣接口限流概率
    await new Promise((resolve) => setTimeout(resolve, index * 200));
    while (cursor < items.length && Date.now() < deadline) {
      const item = items[cursor++];
      item.poster = await resolveDoubanPoster(item.title, deadline);
    }
  };
  await Promise.all([0, 1].map((index) => worker(index)));
}

// 腾讯/优酷频道页由前端异步渲染，没有稳定的公开「在更列表」接口，
// 这里仅作兜底快照（参考 guoman_tracker.py 的 SEED_SHOWS），实时数据命中时以实时为准
const SEED_SHOWS: Array<{
  platform: Platform;
  title: string;
  weekday: number;
  pubTime: string;
  rule: string;
  poster: string;
}> = [
  { platform: 'tencent', title: '仙逆', weekday: 1, pubTime: '10:00', rule: '周一 10:00', poster: 'https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2896563963.jpg' },
  { platform: 'tencent', title: '吞噬星空', weekday: 2, pubTime: '10:00', rule: '周二 10:00', poster: 'https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2616542123.jpg' },
  { platform: 'tencent', title: '遮天', weekday: 3, pubTime: '10:00', rule: '周三 10:00', poster: 'https://img9.doubanio.com/view/photo/s_ratio_poster/public/p2907302975.jpg' },
  { platform: 'tencent', title: '斩神之凡尘神域 第二季', weekday: 4, pubTime: '10:00', rule: '周四 10:00', poster: 'https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2910686126.jpg' },
  { platform: 'tencent', title: '完美世界', weekday: 5, pubTime: '10:00', rule: '周五 10:00', poster: 'https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2912507200.jpg' },
  { platform: 'tencent', title: '诛仙 最终季', weekday: 5, pubTime: '10:00', rule: '周五 10:00', poster: 'https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2924165930.jpg' },
  { platform: 'tencent', title: '斗罗大陆Ⅱ绝世唐门', weekday: 6, pubTime: '10:00', rule: '周六 10:00', poster: 'https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2877604309.jpg' },
  { platform: 'tencent', title: '斗破苍穹 年番', weekday: 7, pubTime: '10:00', rule: '周日 10:00', poster: 'https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2924137391.jpg' },
  { platform: 'youku', title: '一斩苍穹', weekday: 2, pubTime: '10:00', rule: '周二 10:00', poster: 'https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2936965402.jpg' },
  { platform: 'youku', title: '师兄啊师兄', weekday: 3, pubTime: '10:00', rule: '周三更新', poster: 'https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2886674611.jpg' },
  { platform: 'youku', title: '沧元图 第三季', weekday: 5, pubTime: '10:00', rule: '周五更新', poster: 'https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2895307568.jpg' },
  { platform: 'youku', title: '光阴之外 第二季', weekday: 6, pubTime: '10:00', rule: '周六更新', poster: 'https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2932805103.jpg' },
];

let cachedResult: { at: number; list: GuomanItem[] } | null = null;
const RESULT_CACHE_TTL = 10 * 60 * 1000;

// 豆瓣图床禁止外站直连，统一走站内代理
function toClientPoster(url: string): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol === 'https:' &&
      /^img\d+\.doubanio\.com$/.test(parsed.hostname)
    ) {
      return `/api/guoman/poster?url=${encodeURIComponent(url)}`;
    }
  } catch {
    return url;
  }
  return url;
}

export async function getGuomanCalendar(): Promise<GuomanItem[]> {
  if (cachedResult && Date.now() - cachedResult.at < RESULT_CACHE_TTL) {
    return cachedResult.list;
  }

  const settled = await Promise.allSettled([
    fetchBilibili(),
    fetchTencent(),
    fetchYouku(),
  ]);
  const merged: RawShow[] = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') merged.push(...result.value);
  }

  const byKey = new Map<string, RawShow>();
  for (const item of merged) {
    byKey.set(`${item.platform}|${normalizeTitle(item.title)}`, item);
  }
  // 兜底快照只补充实时数据里没有的条目
  for (const seed of SEED_SHOWS) {
    const key = `${seed.platform}|${normalizeTitle(seed.title)}`;
    if (byKey.has(key)) continue;
    byKey.set(
      key,
      makeRawShow(
        seed.platform,
        seed.title,
        seed.weekday,
        { pubTime: seed.pubTime, latest: '', rule: seed.rule },
        seed.poster,
        ''
      )
    );
  }

  // 星期未知的条目一律不进入结果
  const kept = Array.from(byKey.values()).filter(
    (item) => item.weekday >= 1 && item.weekday <= 7
  );
  // 展示顺序：周六、周日、周一 … 周五
  const weekdayOrder: Record<number, number> = {
    6: 0,
    7: 1,
    1: 2,
    2: 3,
    3: 4,
    4: 5,
    5: 6,
  };
  kept.sort(
    (a, b) =>
      (weekdayOrder[a.weekday] ?? a.weekday) -
        (weekdayOrder[b.weekday] ?? b.weekday) ||
      a.pubTime.localeCompare(b.pubTime) ||
      a.title.localeCompare(b.title)
  );

  await enrichPosters(kept);

  const list: GuomanItem[] = kept.map((item) => ({
    id: `${item.platform}-${encodeURIComponent(normalizeTitle(item.title))}`,
    title: item.title,
    poster: toClientPoster(item.poster || item.cover),
    cover: toClientPoster(item.cover),
    platform: PLATFORM_CN[item.platform],
    weekday: item.weekday,
    weekdayLabel: WEEK_CN[item.weekday],
    pubTime: item.pubTime,
    latest: item.latest,
    rule: item.rule,
    sourceUrl: item.sourceUrl,
  }));

  cachedResult = { at: Date.now(), list };
  return list;
}
