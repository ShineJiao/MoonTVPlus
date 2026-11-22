/**
 * 解析 CMS（苹果 CMS / TVBox type=1）返回的 vod_play_url。
 *
 * 格式：线路之间用 $$$ 分隔，分集之间用 # 分隔，标题与地址用 $ 分隔：
 *   第1集$http://a/1.m3u8#第2集$http://a/2.m3u8$$$第1集$http://b/1.m3u8
 *
 * 只保留可直接播放的媒体地址（m3u8 / m3u / mp4，允许带 ?token 等查询参数）。
 * 形如 /play/123-1-1.html 的网页地址需要解析器，无法直接播放，这里跳过。
 * 多条线路时取分集数量最多的一条。
 */
const PLAYABLE_MEDIA_RE = /\.(?:m3u8|m3u|mp4)(?:[?#]|$)/i;

export function isPlayableMediaUrl(url: string): boolean {
  return PLAYABLE_MEDIA_RE.test(url.trim());
}

export function parseCmsPlayEpisodes(vodPlayUrl: string): {
  episodes: string[];
  titles: string[];
} {
  let episodes: string[] = [];
  let titles: string[] = [];

  for (const line of vodPlayUrl.split('$$$')) {
    const matchEpisodes: string[] = [];
    const matchTitles: string[] = [];

    for (const item of line.split('#')) {
      const parts = item.split('$');
      if (parts.length < 2) continue;
      const title = parts[0].trim();
      const url = parts.slice(1).join('$').trim();
      if (title && isPlayableMediaUrl(url)) {
        matchTitles.push(title);
        matchEpisodes.push(url);
      }
    }

    if (matchEpisodes.length > episodes.length) {
      episodes = matchEpisodes;
      titles = matchTitles;
    }
  }

  return { episodes, titles };
}
