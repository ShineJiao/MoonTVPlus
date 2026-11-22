/**
 * 采集源请求工具。
 *
 * 部分部署环境（如受限出网的 Serverless）无法直连部分采集站，
 * 表现为 ECONNRESET / ETIMEDOUT。这里让直连与中转并行竞速：
 * 直连正常时优先使用直连结果，直连失败/过慢时由中转接管。
 *
 * 中转地址格式：https://relay.example.com/?url= （直接拼接目标 URL）
 * 可通过环境变量 SOURCE_RELAY 配置多个，英文逗号分隔。
 */

const DEFAULT_RELAYS = ['https://pz.v88.qzz.io/?url='];

// 直连迟迟没有结果时，推迟这么久再启动中转，避免正常环境下白白占用中转
const RELAY_HEDGE_DELAY_MS = 800;

function getRelays(): string[] {
  const fromEnv = (process.env.SOURCE_RELAY || '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return fromEnv.length > 0 ? fromEnv : DEFAULT_RELAYS;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 中转并发上限。
 *
 * 搜索、源验证会同时发起上百个采集请求，如果全部直连失败后一起压到中转，
 * 中转会因连接数过多直接超时（部署环境实测 UND_ERR_CONNECT_TIMEOUT）。
 * 这里对中转 lane 做全局排队，直连不受影响。
 */
const MAX_RELAY_CONCURRENCY = 8;
let relayActive = 0;
const relayWaiters: Array<() => void> = [];

function releaseRelaySlot(): void {
  const next = relayWaiters.shift();
  if (next) {
    // 槽位直接转交给下一个等待者，active 保持不变
    next();
  } else {
    relayActive = Math.max(0, relayActive - 1);
  }
}

function acquireRelaySlot(signal?: AbortSignal | null): Promise<() => void> {
  if (relayActive < MAX_RELAY_CONCURRENCY) {
    relayActive += 1;
    return Promise.resolve(releaseRelaySlot);
  }
  return new Promise((resolve, reject) => {
    const grant = () => {
      cleanup();
      resolve(releaseRelaySlot);
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException('This operation was aborted', 'AbortError'));
    };
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      const index = relayWaiters.indexOf(grant);
      if (index >= 0) relayWaiters.splice(index, 1);
    };
    if (signal?.aborted) {
      reject(new DOMException('This operation was aborted', 'AbortError'));
      return;
    }
    relayWaiters.push(grant);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function createController(externalSignal?: AbortSignal | null): AbortController {
  const controller = new AbortController();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else
      externalSignal.addEventListener('abort', () => controller.abort(), {
        once: true,
      });
  }
  return controller;
}

async function timedFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  controller: AbortController
): Promise<Response> {
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      cache: 'no-store',
    });
  } finally {
    clearTimeout(timer);
  }
}

// 网络错误或服务端错误（含防盗链 403）时才值得走中转
function shouldRetryViaRelay(response: Response): boolean {
  return (
    response.status === 403 || response.status === 429 || response.status >= 500
  );
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
  const relayTimeoutMs = options.relayTimeoutMs ?? 20000;
  const relays = getRelays();
  const host = hostOf(url);

  const directController = createController(init.signal);
  const baseInit: RequestInit = { ...init, cache: 'no-store' };

  let directError: unknown = null;
  let relayAborted = false;
  let activeRelayController: AbortController | null = null;
  const abortRelay = () => {
    relayAborted = true;
    activeRelayController?.abort();
  };

  const directLane = timedFetch(
    url,
    baseInit,
    directTimeoutMs,
    directController
  ).then(
    (response) => {
      // 直连返回可用的响应就直接用，不再走中转
      if (!shouldRetryViaRelay(response)) {
        return { kind: 'direct' as const, response };
      }
      console.warn(`[source] 直连返回 ${response.status} host=${host}，尝试中转`);
      throw new Error(`HTTP ${response.status}`);
    },
    (error) => {
      directError = error;
      console.warn(`[source] 直连失败 host=${host} ${describeError(error)}`);
      throw error;
    }
  );

  const relayLane = (async () => {
    await delay(RELAY_HEDGE_DELAY_MS);
    for (const relay of relays) {
      if (relayAborted) break;
      // 每个中转都用独立的控制器，避免上一个超时后连累后续重试
      const controller = createController(init.signal);
      activeRelayController = controller;
      // 排队 + 请求共用同一个超时预算，避免排队无限等待
      const deadline = setTimeout(() => controller.abort(), relayTimeoutMs);
      try {
        const release = await acquireRelaySlot(controller.signal);
        try {
          const response = await timedFetch(
            `${relay}${url}`,
            baseInit,
            relayTimeoutMs,
            controller
          );
          if (response.ok) {
            console.info(
              `[source] 中转成功 host=${host} relay=${hostOf(relay)}`
            );
            return { kind: 'relay' as const, response };
          }
          console.warn(
            `[source] 中转返回 ${response.status} host=${host} relay=${hostOf(relay)}`
          );
        } finally {
          release();
        }
      } catch (error) {
        console.warn(
          `[source] 中转失败 host=${host} relay=${hostOf(relay)} ${describeError(
            error
          )}`
        );
      } finally {
        clearTimeout(deadline);
      }
    }
    throw new Error('relay failed');
  })();

  try {
    const winner = await Promise.any([directLane, relayLane]);
    // 只中断落败的那一路，避免影响胜出响应的 body 读取
    if (winner.kind === 'direct') abortRelay();
    else directController.abort();
    return winner.response;
  } catch {
    directController.abort();
    abortRelay();
    throw directError instanceof Error ? directError : new Error('fetch failed');
  }
}

export function isRelayUrl(url: string): boolean {
  return getRelays().some((relay) => url.startsWith(relay));
}
