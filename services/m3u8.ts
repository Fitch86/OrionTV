import Logger from '@/utils/Logger';

const logger = Logger.withTag('M3U8');

interface CacheEntry {
  resolution: string | null;
  timestamp: number;
}

const resolutionCache: { [url: string]: CacheEntry } = {};
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

export const getResolutionFromM3U8 = async (
  url: string,
  signal?: AbortSignal
): Promise<string | null> => {
  const perfStart = performance.now();
  logger.info(`[PERF] M3U8 resolution detection START - url: ${url.substring(0, 100)}...`);

  // 1. Check cache first
  const cachedEntry = resolutionCache[url];
  if (cachedEntry && Date.now() - cachedEntry.timestamp < CACHE_DURATION) {
    const perfEnd = performance.now();
    logger.info(`[PERF] M3U8 resolution detection CACHED - took ${(perfEnd - perfStart).toFixed(2)}ms, resolution: ${cachedEntry.resolution}`);
    return cachedEntry.resolution;
  }

  if (!url.toLowerCase().endsWith(".m3u8")) {
    logger.info(`[PERF] M3U8 resolution detection SKIPPED - not M3U8 file`);
    return null;
  }

  try {
    const fetchStart = performance.now();
    const response = await fetch(url, { signal });
    const fetchEnd = performance.now();
    logger.info(`[PERF] M3U8 fetch took ${(fetchEnd - fetchStart).toFixed(2)}ms, status: ${response.status}`);

    if (!response.ok) {
      return null;
    }

    const parseStart = performance.now();
    const playlist = await response.text();
    const lines = playlist.split("\n");
    let highestResolution = 0;
    let resolutionString: string | null = null;

    for (const line of lines) {
      if (line.startsWith("#EXT-X-STREAM-INF")) {
        const resolutionMatch = line.match(/RESOLUTION=(\d+)x(\d+)/);
        if (resolutionMatch) {
          const height = parseInt(resolutionMatch[2], 10);
          if (height > highestResolution) {
            highestResolution = height;
            resolutionString = `${height}p`;
          }
        }
      }
    }

    const parseEnd = performance.now();
    logger.info(`[PERF] M3U8 parsing took ${(parseEnd - parseStart).toFixed(2)}ms, lines: ${lines.length}`);

    // 2. Store result in cache
    resolutionCache[url] = {
      resolution: resolutionString,
      timestamp: Date.now(),
    };

    const perfEnd = performance.now();
    logger.info(`[PERF] M3U8 resolution detection COMPLETE - took ${(perfEnd - perfStart).toFixed(2)}ms, resolution: ${resolutionString}`);

    return resolutionString;
  } catch (error) {
    const perfEnd = performance.now();
    logger.info(`[PERF] M3U8 resolution detection ERROR - took ${(perfEnd - perfStart).toFixed(2)}ms, error: ${error}`);
    return null;
  }
};

/**
 * 探测视频源的可访问性和响应速度
 * Similar to LunaTV's getVideoResolutionFromM3u8 + preferBestSource
 * 在播放前对视频URL进行HEAD请求测试，检测源是否可用及响应速度
 */
export interface SourceProbeResult {
  accessible: boolean;
  pingMs: number;
  resolution: string | null;
  contentType: string | null;
  error?: string;
}

export const probeVideoSource = async (
  url: string,
  timeoutMs: number = 5000
): Promise<SourceProbeResult> => {
  const perfStart = performance.now();
  logger.info(`[PROBE] Testing video source: ${url.substring(0, 100)}...`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // 1. HEAD请求测ping和可访问性
    const pingStart = performance.now();
    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
    });
    const pingMs = Math.round(performance.now() - pingStart);

    clearTimeout(timeoutId);

    if (!response.ok) {
      const result: SourceProbeResult = {
        accessible: false,
        pingMs,
        resolution: null,
        contentType: response.headers.get('content-type'),
        error: `HTTP ${response.status}`,
      };
      logger.warn(`[PROBE] Source returned HTTP ${response.status} in ${pingMs}ms`);
      return result;
    }

    // 2. 如果是m3u8，进一步解析分辨率
    let resolution: string | null = null;
    const contentType = response.headers.get('content-type') || '';
    const isM3U8 = url.toLowerCase().includes('.m3u8') ||
      contentType.includes('mpegurl') ||
      contentType.includes('vnd.apple.mpegurl');

    if (isM3U8) {
      resolution = await getResolutionFromM3U8(url);
    }

    const perfEnd = performance.now();
    logger.info(`[PROBE] Source accessible - ping: ${pingMs}ms, resolution: ${resolution || 'N/A'}, total: ${(perfEnd - perfStart).toFixed(0)}ms`);

    return {
      accessible: true,
      pingMs,
      resolution,
      contentType,
    };
  } catch (error: any) {
    clearTimeout(timeoutId);
    const pingMs = Math.round(performance.now() - perfStart);
    const errorMsg = error?.name === 'AbortError' ? 'timeout' : (error?.message || 'unknown');
    logger.warn(`[PROBE] Source test failed: ${errorMsg} after ${pingMs}ms`);
    return {
      accessible: false,
      pingMs,
      resolution: null,
      contentType: null,
      error: errorMsg,
    };
  }
};

/**
 * 对多个视频源进行并发探测，返回按优先级排序的结果
 * LunaTV的preferBestSource在Android TV上的等价实现
 */
export interface SourceWithProbe {
  sourceKey: string;
  sourceName: string;
  episodeUrl: string;
  probeResult: SourceProbeResult;
}

export const probeMultipleSources = async (
  sources: Array<{ key: string; name: string; episodeUrl: string }>,
  concurrency: number = 3
): Promise<SourceWithProbe[]> => {
  logger.info(`[PROBE] Starting multi-source probe for ${sources.length} sources`);
  const results: SourceWithProbe[] = [];

  // 分批并发探测，避免过多请求
  for (let i = 0; i < sources.length; i += concurrency) {
    const batch = sources.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (src) => {
        const probeResult = await probeVideoSource(src.episodeUrl);
        return {
          sourceKey: src.key,
          sourceName: src.name,
          episodeUrl: src.episodeUrl,
          probeResult,
        };
      })
    );
    results.push(...batchResults);
  }

  // 按可访问性和ping排序：可访问的排前面，ping低的排前面
  const sorted = results.sort((a, b) => {
    // 不可访问的排最后
    if (a.probeResult.accessible !== b.probeResult.accessible) {
      return a.probeResult.accessible ? -1 : 1;
    }
    // 都可访问时，按ping排序
    return a.probeResult.pingMs - b.probeResult.pingMs;
  });

  logger.info(`[PROBE] Results: ${sorted.filter(s => s.probeResult.accessible).length}/${sources.length} accessible`);
  sorted.forEach((s, i) => {
    logger.info(`[PROBE] #${i + 1} ${s.sourceName}: accessible=${s.probeResult.accessible}, ping=${s.probeResult.pingMs}ms, res=${s.probeResult.resolution || 'N/A'}`);
  });

  return sorted;
};
