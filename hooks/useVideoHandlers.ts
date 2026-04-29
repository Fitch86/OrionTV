import { useCallback, RefObject, useMemo, useRef } from 'react';
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

// 上一集URL的ref，用于检测真正的源切换
let _lastLoadedUrl = '';

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

    try {
      const jumpPosition = initialPosition || introEndTime || 0;
      if (jumpPosition > 0) {
        logger.info(`Setting initial position to ${jumpPosition}ms`);
        await videoRef.current?.setPositionAsync(jumpPosition);
      }

      logger.info(`Attempting to start playback after onLoad`);
      await videoRef.current?.playAsync();
      logger.info(`Auto-play successful after onLoad`);

      usePlayerStore.setState({ isLoading: false });
      logger.info(`Video loading complete - isLoading set to false`);
    } catch (error) {
      logger.warn(`Failed to auto-play after onLoad:`, error);
      usePlayerStore.setState({ isLoading: false });
    }
  }, [videoRef, initialPosition, introEndTime]);

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
      logger.error(`SSL certificate validation failed for URL: ${currentEpisode.url}`);
      Toast.show({
        type: "error",
        text1: "SSL证书错误，正在尝试其他播放源...",
        text2: "请稍候"
      });
      usePlayerStore.getState().handleVideoError('ssl', currentEpisode.url);
    } else if (isNetworkError) {
      logger.error(`Network connection failed for URL: ${currentEpisode.url}`);
      Toast.show({
        type: "error",
        text1: "网络连接失败，正在尝试其他播放源...",
        text2: "请稍候"
      });
      usePlayerStore.getState().handleVideoError('network', currentEpisode.url);
    } else {
      logger.error(`Other video error for URL: ${currentEpisode.url}`);
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
