import { useCallback, RefObject, useMemo } from 'react';
import { Video, ResizeMode } from 'expo-av';
import Toast from 'react-native-toast-message';
import usePlayerStore from '@/stores/playerStore';
import Logger from '@/utils/Logger';

const logger = Logger.withTag('VideoHandlers');

interface UseVideoHandlersProps {
  videoRef: RefObject<Video>;
  currentEpisode: { url: string; title: string } | undefined;
  initialPosition: number;
  introEndTime?: number;
  playbackRate: number;
  handlePlaybackStatusUpdate: (status: any) => void;
  deviceType: string;
  detail?: { poster?: string };
}

export const useVideoHandlers = ({
  videoRef,
  currentEpisode,
  initialPosition,
  introEndTime,
  playbackRate,
  handlePlaybackStatusUpdate,
  deviceType,
  detail,
}: UseVideoHandlersProps) => {

  const onLoad = useCallback(async () => {
    logger.info(`Video onLoad - video ready to play`);

    // 从store直接读取最新的initialPosition，避免闭包陈旧问题
    const state = usePlayerStore.getState();
    const pos = state.initialPosition || state.introEndTime || 0;

    try {
      if (pos > 0) {
        logger.info(`Setting initial position to ${pos}ms`);
        await videoRef.current?.setPositionAsync(pos);
      }
      // shouldPlay: true已经让expo-av自动播放，不需要再调用playAsync()
      // 只在shouldPlay未生效时作为备用
      await videoRef.current?.playAsync();
      logger.info(`Auto-play successful after onLoad`);
      usePlayerStore.setState({ isLoading: false });
    } catch (error) {
      logger.warn(`Failed after onLoad:`, error);
      usePlayerStore.setState({ isLoading: false });
    }
  }, [videoRef]); // 只依赖videoRef，位置从store读取

  const onLoadStart = useCallback(() => {
    if (!currentEpisode?.url) return;
    logger.info(`Video onLoadStart - starting to load: ${currentEpisode.url.substring(0, 100)}...`);
    usePlayerStore.setState({ isLoading: true });
  }, [currentEpisode?.url]);

  const onError = useCallback((error: any) => {
    if (!currentEpisode?.url) return;

    logger.error(`Video playback error:`, error);

    const errorString = (error as any)?.error?.toString() || error?.toString() || '';
    const isSSLError = errorString.includes('SSLHandshakeException') ||
      errorString.includes('CertPathValidatorException') ||
      errorString.includes('Trust anchor for certification path not found');
    const isNetworkError = errorString.includes('HttpDataSourceException') ||
      errorString.includes('IOException') ||
      errorString.includes('SocketTimeoutException');

    if (isSSLError) {
      Toast.show({
        type: "error",
        text1: "SSL证书错误，正在尝试其他播放源...",
        text2: "请稍候"
      });
      usePlayerStore.getState().handleVideoError('ssl', currentEpisode.url);
    } else if (isNetworkError) {
      Toast.show({
        type: "error",
        text1: "网络连接失败，正在尝试其他播放源...",
        text2: "请稍候"
      });
      usePlayerStore.getState().handleVideoError('network', currentEpisode.url);
    } else {
      Toast.show({
        type: "error",
        text1: "视频播放失败，正在尝试其他播放源...",
        text2: "请稍候"
      });
      usePlayerStore.getState().handleVideoError('other', currentEpisode.url);
    }
  }, [currentEpisode?.url]);

  const videoProps = useMemo(() => ({
    source: currentEpisode?.url ? { uri: currentEpisode.url } : undefined,
    posterSource: detail?.poster ? { uri: detail.poster } : undefined,
    resizeMode: ResizeMode.CONTAIN,
    rate: playbackRate,
    onPlaybackStatusUpdate: handlePlaybackStatusUpdate,
    onLoad,
    onLoadStart,
    onError,
    useNativeControls: deviceType !== 'tv',
    shouldPlay: true,
    shouldCorrectTiming: true,
    progressUpdateIntervalMillis: 500,
    isLooping: false,
  }), [
    currentEpisode?.url,
    detail?.poster,
    playbackRate,
    handlePlaybackStatusUpdate,
    onLoad,
    onLoadStart,
    onError,
    deviceType,
  ]);

  return {
    onLoad,
    onLoadStart,
    onError,
    videoProps,
  };
};
