/** TVBox 订阅直接导入：客户端与服务端共用的类型定义。 */
export interface TVBoxIngestSite {
  /** 导入后作为视频源 key（tvbox_ 前缀，避免与桥接保留的 tvbox: 冲突） */
  key: string;
  /** 视频源显示名称 */
  name: string;
  /** 规范化后的 CMS API 地址（已去掉 ac 参数与 query） */
  api: string;
  /** 订阅内的原始站点 key */
  siteKey: string;
  /** 该站点来自哪个订阅/仓库地址 */
  sourceUrl: string;
}

export interface TVBoxIngestPreview {
  configUrl: string;
  /** 订阅中声明的站点总数（含不可用类型） */
  totalSites: number;
  /** 可导入的 CMS 站点数（已按 API 去重） */
  usableSites: number;
  /** 因 API 重复被合并的数量 */
  duplicates: number;
  /** 多仓订阅展开的仓库数 */
  repos: number;
  sites: TVBoxIngestSite[];
}
