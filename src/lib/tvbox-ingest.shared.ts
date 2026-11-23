/** TVBox 订阅 → 视频源：客户端与服务端共用的类型定义。 */
export interface TVBoxIngestSite {
  /** 导入后作为视频源 key */
  key: string;
  name: string;
  /** CMS 接口地址（已去掉查询参数） */
  api: string;
  /** TVBox 里的站点类型，目前只导入 type=1 的 CMS 源 */
  type: number;
}

export interface TVBoxIngestPreview {
  configUrl: string;
  /** 订阅中声明的站点总数 */
  totalSites: number;
  /** 可导入的 CMS 源数（已按接口地址去重） */
  usableSites: number;
  /** 因接口地址重复被合并的数量 */
  duplicates: number;
  /** 多仓订阅展开的仓库数 */
  repos: number;
  sites: TVBoxIngestSite[];
}
