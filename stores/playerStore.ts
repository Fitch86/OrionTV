import { create } from "zustand";
import Toast from "react-native-toast-message";
import { AVPlaybackStatus, Video } from "expo-av";
import { RefObject } from "react";
import { PlayRecord, PlayRecordManager, PlayerSettingsManager } from "@/services/storage";
import useDetailStore, { episodesSelectorBySource } from "./detailStore";
import Logger from '@/utils/Logger';

const logger = Logger.withTag('PlayerStore');

// Toast去重：同一消息5秒内不重复弹出
let _lastToastText = '';
let _lastToastTime = 0;
const TOAST_DEDUP_MS = 5000;
const showToast = (type: string, text1: string, text2?: string) => {
  const now = Date.now();
  const key = `${type}-${text1}`;
  if (key === _lastToastText && now - _lastToastTime < TOAST_DEDUP_MS) return;
  _lastToastText = key;
  _lastToastTime = now;
  Toast.show({ type: type as any, text1, text2 });
};

// 缓冲停滞检测阈值
const STALL_TIMEOUT = 15000; // 15s无进度视为停滞
const MAX_RETRIES = 2; // 停滞后最大重试次数
const CONSECUTIVE_ERROR_THRESHOLD = 3; // 连续API失败阈值

interface Episode {
  url: string;
  title: string;
}

interface PlayerState {
  videoRef: RefObject<Video> | null;
  videoKey: number; // 仅在播放器真正死亡时才递增，强制Video组件重新挂载
  currentEpisodeIndex: number;
  episodes: Episode[];
  status: AVPlaybackStatus | null;
  isLoading: boolean;
  showControls: boolean;
  showEpisodeModal: boolean;
  showSourceModal: boolean;
  showSpeedModal: boolean;
  showNextEpisodeOverlay: boolean;
  isSeeking: boolean;
  seekPosition: number;
  progressPosition: number;
  initialPosition: number;
  playbackRate: number;
  introEndTime?: number;
  outroStartTime?: number;
  retryCount: number;
  stallTimer?: NodeJS.Timeout;
  lastPositionMillis: number;
  consecutiveApiErrors: number;
  setVideoRef: (ref: RefObject<Video> ) => void;
  loadVideo: (options: {
    source: string;
    id: string;
    title: string;
    episodeIndex: number;
    position?: number;
  }) => Promise<void>;
  playEpisode: (index: number) => void;
  togglePlayPause: () => void;
  seek: (duration: number) => void;
  handlePlaybackStatusUpdate: (newStatus: AVPlaybackStatus) => void;
  setLoading: (loading: boolean) => void;
  setShowControls: (show: boolean) => void;
  setShowEpisodeModal: (show: boolean) => void;
  setShowSourceModal: (show: boolean) => void;
  setShowSpeedModal: (show: boolean) => void;
  setShowNextEpisodeOverlay: (show: boolean) => void;
  setPlaybackRate: (rate: number) => void;
  setIntroEndTime: () => void;
  setOutroStartTime: () => void;
  reset: () => void;
  _seekTimeout?: NodeJS.Timeout;
  _isRecordSaveThrottled: boolean;
  _savePlayRecord: (updates?: Partial<PlayRecord>, options?: { immediate?: boolean }) => void;
  handleVideoError: (errorType: 'ssl' | 'network' | 'stall' | 'other', failedUrl: string) => Promise<void>;
  _startStallDetection: () => void;
  _stopStallDetection: () => void;
  _handleStall: () => void;
  _rebuildVideo: () => void; // 仅在播放器死亡时调用
  _safeCall: (fn: () => Promise<void>, errorText: string) => Promise<boolean>; // 返回是否成功
}

const usePlayerStore = create<PlayerState>((set, get) => ({
  videoRef: null,
  videoKey: 0,
  episodes: [],
  currentEpisodeIndex: -1,
  status: null,
  isLoading: true,
  showControls: false,
  showEpisodeModal: false,
  showSourceModal: false,
  showSpeedModal: false,
  showNextEpisodeOverlay: false,
  isSeeking: false,
  seekPosition: 0,
  progressPosition: 0,
  initialPosition: 0,
  playbackRate: 1.0,
  introEndTime: undefined,
  outroStartTime: undefined,
  _seekTimeout: undefined,
  _isRecordSaveThrottled: false,
  retryCount: 0,
  stallTimer: undefined,
  lastPositionMillis: 0,
  consecutiveApiErrors: 0,

  setVideoRef: (ref) => set({ videoRef: ref }),

  // 强制重建Video组件 - 只在ExoPlayer真的进入不可恢复状态时使用
  // 绝不在常规操作（切集、暂停、快进等）中使用
  _rebuildVideo: () => {
    const { videoKey, consecutiveApiErrors } = get();
    logger.warn(`[REBUILD] Forcing Video component rebuild (key ${videoKey} -> ${videoKey + 1}), consecutive errors: ${consecutiveApiErrors}`);
    set({
      videoKey: videoKey + 1,
      consecutiveApiErrors: 0,
    });
  },

  // 安全调用Video API - 捕获异常但不轻易重建
  // 返回true表示成功，false表示失败
  _safeCall: async (fn, errorText) => {
    try {
      await fn();
      set({ consecutiveApiErrors: 0 });
      return true;
    } catch (error: any) {
      const { consecutiveApiErrors, status } = get();
      const errorMsg = error?.toString()?.substring(0, 200) || 'unknown';
      logger.warn(`[SAFE_CALL] ${errorText} failed: ${errorMsg}`);

      // 只有当错误明确表示播放器未加载时才计入连续错误
      const isPlayerNotLoaded = !status?.isLoaded;
      const isFatalError = errorMsg.includes('not loaded') || errorMsg.includes('is not available') || errorMsg.includes('Player is not');

      if (isPlayerNotLoaded || isFatalError) {
        const newCount = consecutiveApiErrors + 1;
        set({ consecutiveApiErrors: newCount });

        if (newCount >= CONSECUTIVE_ERROR_THRESHOLD) {
          logger.error(`[SAFE_CALL] Player appears dead (errors=${newCount}), forcing rebuild`);
          get()._rebuildVideo();
          showToast("info", "正在恢复播放器...", "请稍候");
        } else {
          showToast("error", errorText);
        }
      } else {
        // 非致命错误（如正在缓冲中操作被拒绝），只提示不重建
        showToast("error", errorText);
      }
      return false;
    }
  },

  _startStallDetection: () => {
    get()._stopStallDetection();
    const { lastPositionMillis, status } = get();
    const timer = setTimeout(() => {
      const currentState = get();
      if (currentState.isLoading && currentState.lastPositionMillis === lastPositionMillis) {
        logger.warn(`[STALL] Buffering stall detected - no progress for ${STALL_TIMEOUT}ms`);
        get()._handleStall();
      }
    }, STALL_TIMEOUT);
    set({ stallTimer: timer, lastPositionMillis: (status as any)?.positionMillis || 0 });
  },

  _stopStallDetection: () => {
    const { stallTimer } = get();
    if (stallTimer) {
      clearTimeout(stallTimer);
      set({ stallTimer: undefined });
    }
  },

  _handleStall: () => {
    const { retryCount, episodes, currentEpisodeIndex } = get();
    const currentUrl = episodes[currentEpisodeIndex]?.url;

    if (retryCount < MAX_RETRIES) {
      logger.info(`[STALL] Retry ${retryCount + 1}/${MAX_RETRIES} - forcing Video rebuild`);
      set({ retryCount: retryCount + 1 });
      get()._rebuildVideo();
      showToast("info", "视频加载缓慢，正在重试...");
    } else {
      logger.error(`[STALL] Max retries reached, switching to fallback source`);
      set({ retryCount: 0 });
      if (currentUrl) {
        Toast.show({
          type: "error",
          text1: "视频加载停滞，正在尝试其他播放源...",
          text2: "请稍候"
        });
        get().handleVideoError('stall', currentUrl);
      }
    }
  },

  loadVideo: async ({ source, id, episodeIndex, position, title }) => {
    const perfStart = performance.now();
    logger.info(`[PERF] PlayerStore.loadVideo START - source: ${source}, id: ${id}, title: ${title}`);

    let detail = useDetailStore.getState().detail;
    let episodes: string[] = [];

    if (detail && detail.source) {
      episodes = episodesSelectorBySource(detail.source)(useDetailStore.getState());
    } else {
      episodes = episodesSelectorBySource(source)(useDetailStore.getState());
    }

    set({ isLoading: true, retryCount: 0, consecutiveApiErrors: 0 });
    get()._stopStallDetection();

    const needsDetailInit = !detail || !episodes || episodes.length === 0 || detail.title !== title;

    if (needsDetailInit) {
      const detailInitStart = performance.now();
      logger.info(`[PERF] DetailStore.init START - ${title}`);

      await useDetailStore.getState().init(title, source, id);

      const detailInitEnd = performance.now();
      logger.info(`[PERF] DetailStore.init END - took ${(detailInitEnd - detailInitStart).toFixed(2)}ms`);

      detail = useDetailStore.getState().detail;

      if (!detail) {
        logger.error(`[ERROR] Detail not found after initialization for "${title}"`);
        set({ isLoading: false });
        return;
      }

      episodes = episodesSelectorBySource(detail.source)(useDetailStore.getState());

      if (!episodes || episodes.length === 0) {
        const sourceWithEpisodes = useDetailStore.getState().searchResults.find(r => r.episodes && r.episodes.length > 0);
        if (sourceWithEpisodes) {
          episodes = sourceWithEpisodes.episodes;
          detail = sourceWithEpisodes;
        } else {
          set({ isLoading: false });
          return;
        }
      }
    } else {
      if (detail && detail.source && detail.source !== source) {
        episodes = episodesSelectorBySource(detail.source)(useDetailStore.getState());
        if (!episodes || episodes.length === 0) {
          episodes = episodesSelectorBySource(source)(useDetailStore.getState());
        }
      }
    }

    if (!detail || !episodes || episodes.length === 0) {
      logger.error(`[ERROR] No detail or episodes available`);
      set({ isLoading: false });
      return;
    }

    try {
      const playRecord = await PlayRecordManager.get(detail!.source, detail!.id.toString());
      const playerSettings = await PlayerSettingsManager.get(detail!.source, detail!.id.toString());

      const initialPositionFromRecord = playRecord?.play_time ? playRecord.play_time * 1000 : 0;
      const savedPlaybackRate = playerSettings?.playbackRate || 1.0;

      const mappedEpisodes = episodes.map((ep, index) => ({
        url: ep,
        title: `第 ${index + 1} 集`,
      }));

      // 关键：不递增videoKey！让expo-av通过source prop变化自己处理
      // 只有播放器真的死掉时才用videoKey重建
      set({
        isLoading: true,
        currentEpisodeIndex: episodeIndex,
        initialPosition: position || initialPositionFromRecord,
        playbackRate: savedPlaybackRate,
        episodes: mappedEpisodes,
        introEndTime: playRecord?.introEndTime || playerSettings?.introEndTime,
        outroStartTime: playRecord?.outroStartTime || playerSettings?.outroStartTime,
        consecutiveApiErrors: 0,
      });

      // 启动停滞检测
      get()._startStallDetection();

      const perfEnd = performance.now();
      logger.info(`[PERF] PlayerStore.loadVideo COMPLETE - total time: ${(perfEnd - perfStart).toFixed(2)}ms`);
    } catch (error) {
      logger.debug("Failed to load play record", error);
      set({ isLoading: false });
    }
  },

  playEpisode: (index) => {
    const { episodes } = get();
    if (index >= 0 && index < episodes.length) {
      get()._stopStallDetection();
      set({ retryCount: 0, consecutiveApiErrors: 0 });

      // 关键修复：不递增videoKey！
      // expo-av的Video组件能感知source prop变化并自动切换源
      // 递增videoKey会导致整个ExoPlayer销毁重建，黑屏/定格
      set({
        isLoading: true,
        currentEpisodeIndex: index,
        showNextEpisodeOverlay: false,
        initialPosition: 0,
        progressPosition: 0,
        seekPosition: 0,
      });

      logger.info(`[EPISODE] Switching to episode ${index + 1}, URL: ${episodes[index].url.substring(0, 80)}...`);

      // 启动停滞检测
      get()._startStallDetection();
    }
  },

  togglePlayPause: async () => {
    const { status, videoRef } = get();
    if (!status?.isLoaded) {
      logger.warn(`[TOGGLE] Player not loaded, attempting rebuild`);
      get()._rebuildVideo();
      return;
    }
    // 缓冲中不提示错误，等缓冲完自动播放
    if (status.isBuffering) {
      logger.info(`[TOGGLE] Player is buffering, ignoring toggle`);
      return;
    }
    if (status.isPlaying) {
      await get()._safeCall(async () => {
        await videoRef?.current?.pauseAsync();
      }, "暂停失败");
    } else {
      await get()._safeCall(async () => {
        await videoRef?.current?.playAsync();
      }, "播放失败");
    }
  },

  seek: async (duration) => {
    const { status, videoRef } = get();
    if (!status?.isLoaded || !status.durationMillis) return;

    const newPosition = Math.max(0, Math.min(status.positionMillis + duration, status.durationMillis));

    // 快进快退：直接调用setPositionAsync，不做_safeCall的重建逻辑
    // 如果正在缓冲中调用失败，只是临时问题不应触发重建
    try {
      await videoRef?.current?.setPositionAsync(newPosition);
      set({
        isSeeking: true,
        seekPosition: newPosition / status.durationMillis,
      });

      if (get()._seekTimeout) {
        clearTimeout(get()._seekTimeout);
      }
      const timeoutId = setTimeout(() => set({ isSeeking: false }), 1000);
      set({ _seekTimeout: timeoutId });
    } catch (error) {
      logger.warn(`[SEEK] Seek failed:`, error?.toString()?.substring(0, 100));
      // 快进快退失败不触发重建，只是提示
      // 快进快退失败静默处理，不弹toast干扰
    }
  },

  setIntroEndTime: () => {
    const { status, introEndTime: existingIntroEndTime } = get();
    const detail = useDetailStore.getState().detail;
    if (!status?.isLoaded || !detail) return;

    if (existingIntroEndTime) {
      set({ introEndTime: undefined });
      get()._savePlayRecord({ introEndTime: undefined }, { immediate: true });
      showToast("info", "已清除片头时间");
    } else {
      const newIntroEndTime = status.positionMillis;
      set({ introEndTime: newIntroEndTime });
      get()._savePlayRecord({ introEndTime: newIntroEndTime }, { immediate: true });
      showToast("success", "设置成功", "片头时间已记录");
    }
  },

  setOutroStartTime: () => {
    const { status, outroStartTime: existingOutroStartTime } = get();
    const detail = useDetailStore.getState().detail;
    if (!status?.isLoaded || !detail) return;

    if (existingOutroStartTime) {
      set({ outroStartTime: undefined });
      get()._savePlayRecord({ outroStartTime: undefined }, { immediate: true });
      showToast("info", "已清除片尾时间");
    } else {
      if (!status.durationMillis) return;
      const newOutroStartTime = status.durationMillis - status.positionMillis;
      set({ outroStartTime: newOutroStartTime });
      get()._savePlayRecord({ outroStartTime: newOutroStartTime }, { immediate: true });
      showToast("success", "设置成功", "片尾时间已记录");
    }
  },

  _savePlayRecord: (updates = {}, options = {}) => {
    const { immediate = false } = options;
    if (!immediate) {
      if (get()._isRecordSaveThrottled) {
        return;
      }
      set({ _isRecordSaveThrottled: true });
      setTimeout(() => {
        set({ _isRecordSaveThrottled: false });
      }, 10000);
    }

    const { detail } = useDetailStore.getState();
    const { currentEpisodeIndex, episodes, status, introEndTime, outroStartTime } = get();
    if (detail && status?.isLoaded) {
      const existingRecord = {
        introEndTime,
        outroStartTime,
      };
      PlayRecordManager.save(detail.source, detail.id.toString(), {
        title: detail.title,
        cover: detail.poster || "",
        index: currentEpisodeIndex + 1,
        total_episodes: episodes.length,
        play_time: Math.floor(status.positionMillis / 1000),
        total_time: status.durationMillis ? Math.floor(status.durationMillis / 1000) : 0,
        source_name: detail.source_name,
        year: detail.year || "",
        ...existingRecord,
        ...updates,
      });
    }
  },

  handlePlaybackStatusUpdate: (newStatus) => {
    if (!newStatus.isLoaded) {
      if (newStatus.error) {
        logger.debug(`Playback Error: ${newStatus.error}`);
      }
      set({ status: newStatus });
      return;
    }

    const { currentEpisodeIndex, episodes, outroStartTime, playEpisode, retryCount } = get();
    const detail = useDetailStore.getState().detail;

    const currentPosition = newStatus.positionMillis || 0;
    const wasLoading = get().isLoading;

    // 播放成功时重置计数
    if (newStatus.isPlaying) {
      if (wasLoading) {
        set({ isLoading: false, retryCount: 0, consecutiveApiErrors: 0 });
        get()._stopStallDetection();
      }
      set({ lastPositionMillis: currentPosition });
    }

    // 缓冲中但位置变化
    if (newStatus.isBuffering && currentPosition !== get().lastPositionMillis) {
      set({ lastPositionMillis: currentPosition });
      get()._startStallDetection();
    }

    if (
      outroStartTime &&
      newStatus.durationMillis &&
      newStatus.positionMillis >= newStatus.durationMillis - outroStartTime
    ) {
      if (currentEpisodeIndex < episodes.length - 1) {
        playEpisode(currentEpisodeIndex + 1);
        return;
      }
    }

    if (detail && newStatus.durationMillis) {
      get()._savePlayRecord();

      const isNearEnd = newStatus.positionMillis / newStatus.durationMillis > 0.95;
      if (isNearEnd && currentEpisodeIndex < episodes.length - 1 && !outroStartTime) {
        set({ showNextEpisodeOverlay: true });
      } else {
        set({ showNextEpisodeOverlay: false });
      }
    }

    if (newStatus.didJustFinish) {
      if (currentEpisodeIndex < episodes.length - 1) {
        playEpisode(currentEpisodeIndex + 1);
      }
    }

    const progressPosition = newStatus.durationMillis ? newStatus.positionMillis / newStatus.durationMillis : 0;
    set({ status: newStatus, progressPosition });
  },

  setLoading: (loading) => set({ isLoading: loading }),
  setShowControls: (show) => set({ showControls: show }),
  setShowEpisodeModal: (show) => set({ showEpisodeModal: show }),
  setShowSourceModal: (show) => set({ showSourceModal: show }),
  setShowSpeedModal: (show) => set({ showSpeedModal: show }),
  setShowNextEpisodeOverlay: (show) => set({ showNextEpisodeOverlay: show }),

  setPlaybackRate: async (rate) => {
    const { videoRef } = get();
    const detail = useDetailStore.getState().detail;

    try {
      await videoRef?.current?.setRateAsync(rate, true);
      set({ playbackRate: rate });
      if (detail) {
        await PlayerSettingsManager.save(detail.source, detail.id.toString(), { playbackRate: rate });
      }
    } catch (error) {
      logger.warn(`[RATE] Set rate failed:`, error?.toString()?.substring(0, 100));
      showToast("error", "设置播放速度失败");
    }
  },

  reset: () => {
    get()._stopStallDetection();
    set({
      episodes: [],
      currentEpisodeIndex: 0,
      status: null,
      isLoading: true,
      showControls: false,
      showEpisodeModal: false,
      showSourceModal: false,
      showSpeedModal: false,
      showNextEpisodeOverlay: false,
      initialPosition: 0,
      playbackRate: 1.0,
      introEndTime: undefined,
      outroStartTime: undefined,
      retryCount: 0,
      lastPositionMillis: 0,
      consecutiveApiErrors: 0,
      // 不在这里递增videoKey，因为组件已经在卸载了
    });
  },

  handleVideoError: async (errorType: 'ssl' | 'network' | 'stall' | 'other', failedUrl: string) => {
    const perfStart = performance.now();
    logger.error(`[VIDEO_ERROR] Handling ${errorType} error for URL: ${failedUrl.substring(0, 100)}`);

    get()._stopStallDetection();

    const detailStoreState = useDetailStore.getState();
    const { detail } = detailStoreState;
    const { currentEpisodeIndex } = get();

    if (!detail) {
      logger.error(`[VIDEO_ERROR] Cannot fallback - no detail available`);
      set({ isLoading: false });
      return;
    }

    const currentSource = detail.source;
    const errorReason = `${errorType} error: ${failedUrl.substring(0, 100)}...`;
    useDetailStore.getState().markSourceAsFailed(currentSource, errorReason);

    const fallbackSource = useDetailStore.getState().getNextAvailableSource(currentSource, currentEpisodeIndex);

    if (!fallbackSource) {
      logger.error(`[VIDEO_ERROR] No fallback sources available for episode ${currentEpisodeIndex + 1}`);
      showToast("error", "播放失败", "所有播放源都不可用");
      set({ isLoading: false });
      return;
    }

    logger.info(`[VIDEO_ERROR] Switching to fallback source: ${fallbackSource.source} (${fallbackSource.source_name})`);

    try {
      await useDetailStore.getState().setDetail(fallbackSource);

      const newEpisodes = fallbackSource.episodes || [];
      if (newEpisodes.length > currentEpisodeIndex) {
        const mappedEpisodes = newEpisodes.map((ep, index) => ({
          url: ep,
          title: `第 ${index + 1} 集`,
        }));

        // 源切换时不递增videoKey，让source prop变化自己处理
        set({
          episodes: mappedEpisodes,
          isLoading: true,
          retryCount: 0,
          consecutiveApiErrors: 0,
        });

        get()._startStallDetection();

        const perfEnd = performance.now();
        logger.info(`[VIDEO_ERROR] Successfully switched to fallback source in ${(perfEnd - perfStart).toFixed(2)}ms`);

        Toast.show({
          type: "success",
          text1: "已切换播放源",
          text2: `正在使用 ${fallbackSource.source_name}`
        });
      } else {
        logger.error(`[VIDEO_ERROR] Fallback source doesn't have episode ${currentEpisodeIndex + 1}`);
        set({ isLoading: false });
      }
    } catch (error) {
      logger.error(`[VIDEO_ERROR] Failed to switch to fallback source:`, error);
      set({ isLoading: false });
    }
  },
}));

export default usePlayerStore;

export const selectCurrentEpisode = (state: PlayerState) => {
  if (
    state.episodes &&
    Array.isArray(state.episodes) &&
    state.episodes.length > 0 &&
    state.currentEpisodeIndex >= 0 &&
    state.currentEpisodeIndex < state.episodes.length
  ) {
    const episode = state.episodes[state.currentEpisodeIndex];
    if (episode && episode.url && episode.url.trim() !== "") {
      return episode;
    }
  }
  return undefined;
};
