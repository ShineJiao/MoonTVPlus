import type { GuomanResult } from './types';

/**
 * 获取国漫在更/放送日历（服务端聚合 B站国创、腾讯视频、优酷动漫公开数据）
 */
export async function getGuomanCalendar(): Promise<GuomanResult> {
  const response = await fetch('/api/guoman/calendar');
  if (!response.ok) {
    throw new Error(`HTTP error! Status: ${response.status}`);
  }
  return response.json();
}
