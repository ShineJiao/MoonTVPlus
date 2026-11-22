import { NextResponse } from 'next/server';

import { getGuomanCalendar } from '@/lib/guoman.server';
import type { GuomanResult } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const list = await getGuomanCalendar();
    const response: GuomanResult = {
      code: 200,
      message: '获取成功',
      list,
    };
    return NextResponse.json(response, {
      headers: {
        'Cache-Control': 'public, max-age=600, s-maxage=600',
      },
    });
  } catch {
    return NextResponse.json(
      { code: 500, message: '获取国漫数据失败', list: [] },
      { status: 500 }
    );
  }
}
