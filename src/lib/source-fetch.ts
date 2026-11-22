/**
 * 采集源请求工具。
 *
 * 部分部署环境（如受限出网的 Serverless）无法直连部分采集站，
 * 表现为 ECONNRESET / ETIMEDOUT。这里在直连失败时自动改用中转地址重试。
 *
 * 中转地址格式：https://relay.example.com/?url= （直接拼接目标 URL）
 * 可通过环境变量 SOURCE_RELAY 配置多个，英文逗号分隔。
 */

const DEFAULT_RELAYS = ['https://pz.v88.qzz.io/?url='];

function getRelays(): string[] {
  const fromEnv = (process.env.SOURCE_RELAY || '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return fromEnv.length > 0 ? fromEnv : DEFAULT_RELAYS;
}

async function timedFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const externalSignal = init.signal;
  const onAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onAbort);
  }
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      cache: 'no-store',
    });
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
  }
}

// 网络错误或服务端错误（含防盗链 403）时才值得走中转
function shouldRetryViaRelay(response: Response): boolean {
  return response.status === 403 || response.status === 429 || response.status >= 500;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// 把 undici 的 cause 链拼成一行，便于在运行日志里定位
function describeError(error: unknown): string {
  const parts: string[] = [];
  let current = error as
    | { name?: string; message?: string; code?: string; cause?: unknown }
    | undefined;
  for (let depth = 0; current && depth < 4; depth++) {
    if (current.code) parts.push(current.code);
    if (current.message) parts.push(current.message);
    current = current.cause as typeof current;
  }
  return parts.join(' | ') || String(error);
}

export async function fetchSource(
  url: string,
  init: RequestInit = {},
  options: { directTimeoutMs?: number; relayTimeoutMs?: number } = {}
): Promise<Response> {
  const directTimeoutMs = options.directTimeoutMs ?? 3000;
  const relayTimeoutMs = options.relayTimeoutMs ?? 4500;
  const host = hostOf(url);

  let directResponse: Response | null = null;
  let directError: unknown = null;
  try {
    directResponse = await timedFetch(url, init, directTimeoutMs);
    if (!shouldRetryViaRelay(directResponse)) {
      return directResponse;
    }
    console.warn(
      `[source] 直连返回 ${directResponse.status} host=${host}，尝试中转`
    );
  } catch (error) {
    directError = error;
    console.warn(`[source] 直连失败 host=${host} ${describeError(error)}`);
  }

  for (const relay of getRelays()) {
    try {
      const response = await timedFetch(`${relay}${url}`, init, relayTimeoutMs);
      if (response.ok) {
        console.info(`[source] 中转成功 host=${host} relay=${hostOf(relay)}`);
        return response;
      }
      console.warn(
        `[source] 中转返回 ${response.status} host=${host} relay=${hostOf(relay)}`
      );
    } catch (error) {
      console.warn(
        `[source] 中转失败 host=${host} relay=${hostOf(relay)} ${describeError(error)}`
      );
    }
  }

  if (directResponse) return directResponse;
  throw directError instanceof Error ? directError : new Error('fetch failed');
}

export function isRelayUrl(url: string): boolean {
  return getRelays().some((relay) => url.startsWith(relay));
}
