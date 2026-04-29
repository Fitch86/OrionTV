import { create } from "zustand";
import Toast from "react-native-toast-message";
import { AVPlaybackStatus, Video } from "expo-av";
import { RefObject } from "react";
import { PlayRecord, PlayRecordManager, PlayerSettingsManager } from "@/services/storage";
import useDetailStore, { episodesSelectorBySource } from "./detailStore";
import Logger from '@/utils/Logger';

const logger = Logger.withTag('PlayerStore');

// 缓冲停滞检测阈值
const STALL_TIMEOUT = 15000; // 15s无进度视为停滞
const MAX_RETRIES = 2; // 停滞后最大重试次数

interface Episode {
  url: string;
  title: string;
}

interface PlayerState {
  videoRef: RefObject<Video> | null;
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
  setVideoRef: (ref: RefObject<Video>) => void;
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
}

const usePlayerStore = create<PlayerState>((set, get) => ({
  videoRef: null,
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

  setVideoRef: (ref) => set({ videoRef: ref }),

  _startStallDetection: () => {
    get()._stopStallDetection();
    const { lastPositionMillis, status } = get();
    const timer = setTimeout(() => {
      const currentState = get();
      // 如果仍在缓冲且位置没变化，判定为停滞
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
      logger.info(`[STALL] Retry ${retryCount + 1}/${MAX_RETRIES} - attempting to reload video`);
      set({ retryCount: retryCount + 1 });
      const { videoRef } = get();
      // 尝试重新加载当前视频
      videoRef?.current?.reloadAsync?.()?.catch(() => {
        // reloadAsync可能不可用，使用replayAsync作为备选
        videoRef?.current?.replayAsync?.()?.catch(() => {});
      });
      Toast.show({
        type: "info",
        text1: "视频加载缓慢，正在重试...",
      });
    } else {
      // 超过重试次数，触发源切换
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
      logger.info(`[INFO] Using existing detail source "${detail.source}" to get episodes`);
      episodes = episodesSelectorBySource(detail.source)(useDetailStore.getState());
    } else {
      logger.info(`[INFO] No existing detail, using provided source "${source}" to get episodes`);
      episodes = episodesSelectorBySource(source)(useDetailStore.getState());
    }

    set({ isLoading: true, retryCount: 0 });
    get()._stopStallDetection();

    const needsDetailInit = !detail || !episodes || episodes.length === 0 || detail.title !== title;
    logger.info(`[PERF] Detail check - needsInit: ${needsDetailInit}, hasDetail: ${!!detail}, episodesCount: ${episodes?.length || 0}`);

    if (needsDetailInit) {
      const detailInitStart = performance.now();
      logger.info(`[PERF] DetailStore.init START - ${title}`);

      await useDetailStore.getState().init(title, source, id);

      const detailInitEnd = performance.now();
      logger.info(`[PERF] DetailStore.init END - took ${(detailInitEnd - detailInitStart).toFixed(2)}ms`);

      detail = useDetailStore.getState().detail;

      if (!detail) {
        logger.error(`[ERROR] Detail not found after initialization for "${title}" (source: ${source}, id: ${id})`);
        const detailStoreState = useDetailStore.getState();
        if (detailStoreState.error) {
          logger.error(`[ERROR] DetailStore error: ${detailStoreState.error}`);
          set({ isLoading: false });
        } else {
          logger.error(`[ERROR] DetailStore init completed but no detail found and no error reported`);
          set({ isLoading: false });
        }
        return;
      }

      logger.info(`[INFO] Using actual source "${detail.source}" instead of preferred source "${source}"`);
      episodes = episodesSelectorBySource(detail.source)(useDetailStore.getState());

      if (!episodes || episodes.length === 0) {
        logger.error(`[ERROR] No episodes found for "${title}" from source "${detail.source}" (${detail.source_name})`);
        const detailStoreState = useDetailStore.getState();
        logger.info(`[INFO] Available sources: ${detailStoreState.searchResults.map(r => `${r.source}(${r.episodes?.length || 0} eps)`).join(', ')}`);

        const sourceWithEpisodes = detailStoreState.searchResults.find(r => r.episodes && r.episodes.length > 0);
        if (sourceWithEpisodes) {
          logger.info(`[FALLBACK] Using alternative source "${sourceWithEpisodes.source}" with ${sourceWithEpisodes.episodes.length} episodes`);
          episodes = sourceWithEpisodes.episodes;
          detail = sourceWithEpisodes;
        } else {
          logger.error(`[ERROR] No source with episodes found in searchResults`);
          set({ isLoading: false });
          return;
        }
      }

      logger.info(`[SUCCESS] Detail and episodes loaded - source: ${detail.source_name}, episodes: ${episodes.length}`);
    } else {
      logger.info(`[PERF] Skipping DetailStore.init - using cached data`);
      if (detail && detail.source && detail.source !== source) {
        logger.info(`[INFO] Cached detail source "${detail.source}" differs from provided source "${source}", updating episodes`);
        episodes = episodesSelectorBySource(detail.source)(useDetailStore.getState());
        if (!episodes || episodes.length === 0) {
          logger.warn(`[WARN] Cached detail source "${detail.source}" has no episodes, trying provided source "${source}"`);
          episodes = episodesSelectorBySource(source)(useDetailStore.getState());
        }
      }
    }

    if (!detail) {
      logger.error(`[ERROR] Final check failed: detail is null`);
      set({ isLoading: false });
      return;
    }

    if (!episodes || episodes.length === 0) {
      logger.error(`[ERROR] Final check failed: no episodes available for source "${detail.source}" (${detail.source_name})`);
      set({ isLoading: false });
      return;
    }

    logger.info(`[SUCCESS] Final validation passed - detail: ${detail.source_name}, episodes: ${episodes.length}`);

    try {
      const storageStart = performance.now();

      const playRecord = await PlayRecordManager.get(detail!.source, detail!.id.toString());
      const storagePlayRecordEnd = performance.now();
      logger.info(`[PERF] PlayRecordManager.get took ${(storagePlayRecordEnd - storageStart).toFixed(2)}ms`);

      const playerSettings = await PlayerSettingsManager.get(detail!.source, detail!.id.toString());
      const storageEnd = performance.now();
      logger.info(`[PERF] PlayerSettingsManager.get took ${(storageEnd - storagePlayRecordEnd).toFixed(2)}ms`);

      const initialPositionFromRecord = playRecord?.play_time ? playRecord.play_time * 1000 : 0;
      const savedPlaybackRate = playerSettings?.playbackRate || 1.0;

      const mappedEpisodes = episodes.map((ep, index) => ({
        url: ep,
        title: `第 ${index + 1} 集`,
      }));

      // 先unload旧视频再设置新状态，避免黑屏
      const { videoRef } = get();
      try {
        await videoRef?.current?.stopAsync();
      } catch (_e) {
        // 忽略stop失败
      }

      set({
        isLoading: true,
        currentEpisodeIndex: episodeIndex,
        initialPosition: position || initialPositionFromRecord,
        playbackRate: savedPlaybackRate,
        episodes: mappedEpisodes,
        introEndTime: playRecord?.introEndTime || playerSettings?.introEndTime,
        outroStartTime: playRecord?.outroStartTime || playerSettings?.outroStartTime,
      });

      // 启动停滞检测
      get()._startStallDetection();

      const perfEnd = performance.now();
      logger.info(`[PERF] PlayerStore.loadVideo COMPLETE - total time: ${(perfEnd - perfStart).toFixed(2)}ms`);
    } catch (error) {
      logger.debug("Failed to load play record", error);
      set({ isLoading: false });

      const perfEnd = performance.now();
      logger.info(`[PERF] PlayerStore.loadVideo ERROR - total time: ${(perfEnd - perfStart).toFixed(2)}ms`);
    }
  },

  playEpisode: async (index) => {
    const { episodes, videoRef } = get();
    if (index >= 0 && index < episodes.length) {
      // 停止旧的停滞检测
      get()._stopStallDetection();
      set({ retryCount: 0 });

      // 先停止当前播放
      try {
        await videoRef?.current?.stopAsync();
      } catch (_e) {
        // 忽略
      }

      set({
        isLoading: true,
        currentEpisodeIndex: index,
        showNextEpisodeOverlay: false,
        initialPosition: 0,
        progressPosition: 0,
        seekPosition: 0,
      });

      // 关键修复：不再使用replayAsync()
      // source prop变化会触发Video组件重新加载新的URL
      // 只需确保状态更新后，Video组件的source已切换
      logger.info(`[EPISODE] Switching to episode ${index + 1}, URL: ${episodes[index].url.substring(0, 80)}...`);

      // 启动停滞检测
      get()._startStallDetection();
    }
  },

  togglePlayPause: async () => {
    const { status, videoRef } = get();
    if (status?.isLoaded) {
      try {
        if (status.isPlaying) {
          await videoRef?.current?.pauseAsync();
        } else {
          await videoRef?.current?.playAsync();
        }
      } catch (error) {
        logger.debug("Failed to toggle play/pause:", error);
        Toast.show({ type: "error", text1: "操作失败" });
      }
    }
  },

  seek: async (duration) => {
    const { status, videoRef } = get();
    if (!status?.isLoaded || !status.durationMillis) return;

    const newPosition = Math.max(0, Math.min(status.positionMillis + duration, status.durationMillis));
    try {
      await videoRef?.current?.setPositionAsync(newPosition);
    } catch (error) {
      logger.debug("Failed to seek video:", error);
      Toast.show({ type: "error", text1: "快进/快退失败" });
    }

    set({
      isSeeking: true,
      seekPosition: newPosition / status.durationMillis,
    });

    if (get()._seekTimeout) {
      clearTimeout(get()._seekTimeout);
    }
    const timeoutId = setTimeout(() => set({ isSeeking: false }), 1000);
    set({ _seekTimeout: timeoutId });
  },

  setIntroEndTime: () => {
    const { status, introEndTime: existingIntroEndTime } = get();
    const detail = useDetailStore.getState().detail;
    if (!status?.isLoaded || !detail) return;

    if (existingIntroEndTime) {
      set({ introEndTime: undefined });
      get()._savePlayRecord({ introEndTime: undefined }, { immediate: true });
      Toast.show({ type: "info", text1: "已清除片头时间" });
    } else {
      const newIntroEndTime = status.positionMillis;
      set({ introEndTime: newIntroEndTime });
      get()._savePlayRecord({ introEndTime: newIntroEndTime }, { immediate: true });
      Toast.show({ type: "success", text1: "设置成功", text2: "片头时间已记录。" });
    }
  },

  setOutroStartTime: () => {
    const { status, outroStartTime: existingOutroStartTime } = get();
    const detail = useDetailStore.getState().detail;
    if (!status?.isLoaded || !detail) return;

    if (existingOutroStartTime) {
      set({ outroStartTime: undefined });
      get()._savePlayRecord({ outroStartTime: undefined }, { immediate: true });
      Toast.show({ type: "info", text1: "已清除片尾时间" });
    } else {
      if (!status.durationMillis) return;
      const newOutroStartTime = status.durationMillis - status.positionMillis;
      set({ outroStartTime: newOutroStartTime });
      get()._savePlayRecord({ outroStartTime: newOutroStartTime }, { immediate: true });
      Toast.show({ type: "success", text1: "设置成功", text2: "片尾时间已记录。" });
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

    // 更新位置追踪，用于停滞检测
    const currentPosition = newStatus.positionMillis || 0;
    const wasLoading = get().isLoading;

    // 如果正在播放，清除加载状态并停止停滞检测
    if (newStatus.isPlaying) {
      if (wasLoading) {
        set({ isLoading: false, retryCount: 0 });
        get()._stopStallDetection();
      }
      set({ lastPositionMillis: currentPosition });
    }

    // 如果缓冲中且位置有变化，说明还在下载，更新位置但保持loading
    if (newStatus.isBuffering && currentPosition !== get().lastPositionMillis) {
      set({ lastPositionMillis: currentPosition });
      // 位置在变但仍在缓冲，重启停滞检测
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
      logger.debug("Failed to set playback rate:", error);
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
      Toast.show({
        type: "error",
        text1: "播放失败",
        text2: "所有播放源都不可用，请稍后重试"
      });
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

        // 停止当前播放再切换
        const { videoRef } = get();
        try {
          await videoRef?.current?.stopAsync();
        } catch (_e) {
          // 忽略
        }

        set({
          episodes: mappedEpisodes,
          isLoading: true,
          retryCount: 0,
        });

        // 启动停滞检测
        get()._startStallDetection();

        const perfEnd = performance.now();
        logger.info(`[VIDEO_ERROR] Successfully switched to fallback source in ${(perfEnd - perfStart).toFixed(2)}ms`);
        logger.info(`[VIDEO_ERROR] New episode URL: ${newEpisodes[currentEpisodeIndex].substring(0, 100)}...`);

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
