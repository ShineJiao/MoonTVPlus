/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

import { NextRequest, NextResponse } from 'next/server';

import type { AdminConfig } from '@/lib/admin.types';
import { getAuthInfoFromCookie } from '@/lib/auth';
import { configSelfCheck, getConfig, setCachedConfig } from '@/lib/config';
import { db } from '@/lib/db';
import {
  fetchTVBoxIngestPreview,
  importTVBoxSources,
} from '@/lib/tvbox-ingest.server';

export const runtime = 'nodejs';

async function ensureAdmin(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo || !authInfo.username) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  if (authInfo.username !== process.env.USERNAME) {
    const userInfo = await db.getUserInfoV2(authInfo.username);
    if (!userInfo || userInfo.role !== 'admin' || userInfo.banned) {
      return { error: NextResponse.json({ error: '权限不足' }, { status: 401 }) };
    }
  }
  return { username: authInfo.username as string };
}

function storageUnsupported() {
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  if (storageType === 'localstorage') {
    return NextResponse.json(
      { error: '不支持本地存储进行管理员配置' },
      { status: 400 }
    );
  }
  return null;
}

/** 解析订阅：返回可导入的 CMS 站点列表，不写入配置。 */
export async function GET(request: NextRequest) {
  const unsupported = storageUnsupported();
  if (unsupported) return unsupported;

  const auth = await ensureAdmin(request);
  if ('error' in auth) return auth.error;

  const url = request.nextUrl.searchParams.get('url')?.trim();
  if (!url) {
    return NextResponse.json({ error: '缺少订阅地址' }, { status: 400 });
  }

  try {
    const preview = await fetchTVBoxIngestPreview(url);
    return NextResponse.json(preview);
  } catch (error) {
    console.error('[tvbox-ingest] 解析失败:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '订阅解析失败' },
      { status: 400 }
    );
  }
}

/** 导入订阅中的 CMS 站点：写入 SourceConfig 并保存配置。 */
export async function POST(request: NextRequest) {
  const unsupported = storageUnsupported();
  if (unsupported) return unsupported;

  const auth = await ensureAdmin(request);
  if ('error' in auth) return auth.error;

  try {
    const body = (await request.json()) as {
      url?: string;
      keys?: string[];
    };
    const url = body.url?.trim();
    if (!url) {
      return NextResponse.json({ error: '缺少订阅地址' }, { status: 400 });
    }

    const config = JSON.parse(JSON.stringify(await getConfig())) as AdminConfig;
    const result = await importTVBoxSources(
      config,
      url,
      Array.isArray(body.keys) ? body.keys : undefined
    );

    if (result.added > 0) {
      const checked = configSelfCheck(config);
      await db.saveAdminConfig(checked);
      await setCachedConfig(checked);
    }

    return NextResponse.json({
      success: true,
      added: result.added,
      skipped: result.skipped,
      total: result.preview.usableSites,
    });
  } catch (error) {
    console.error('[tvbox-ingest] 导入失败:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '订阅导入失败' },
      { status: 500 }
    );
  }
}
