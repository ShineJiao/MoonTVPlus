/** TVBox 订阅 → 电视直播源：客户端与服务端共用的类型定义。 */
export interface TVBoxLiveIngestItem {
  /** 导入后作为直播源 key */
  key: string;
  name: string;
  /** 直播列表地址（m3u / txt） */
  url: string;
  ua?: string;
  epg?: string;
  /** TVBox 里的 type：0=txt，1=m3u */
  type: number;
}

export interface TVBoxLiveIngestPreview {
  configUrl: string;
  /** 订阅中声明的直播源总数 */
  totalLives: number;
  /** 可导入的直播源数（已按地址去重） */
  usableLives: number;
  /** 因地址重复被合并的数量 */
  duplicates: number;
  /** 依赖 TVBox 本机代理、无法直接播放而跳过的数量 */
  skippedLocal: number;
  /** 多仓订阅展开的仓库数 */
  repos: number;
  items: TVBoxLiveIngestItem[];
}
