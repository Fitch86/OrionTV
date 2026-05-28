import React, { useState, useEffect, useCallback, useRef, forwardRef } from "react";
import { View, Text, Image, StyleSheet, Pressable, TouchableOpacity, Animated, Platform } from "react-native";
import { useRouter } from "expo-router";
import { Star, Play } from "lucide-react-native";
import { API } from "@/services/api";
import { ThemedText } from "@/components/ThemedText";
import { Colors } from "@/constants/Colors";
import Logger from '@/utils/Logger';
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";

const logger = Logger.withTag('VideoCardTV');

interface VideoCardProps extends React.ComponentProps<typeof TouchableOpacity> {
  id: string;
  source: string;
  title: string;
  poster: string;
  year?: string;
  rate?: string;
  sourceName?: string;
  progress?: number;
  playTime?: number;
  episodeIndex?: number;
  totalEpisodes?: number;
  onFocus?: () => void;
  api: API;
  deleteMode?: boolean;
  onDeleteRecord?: (source: string, id: string, title: string) => void;
}

const VideoCard = forwardRef<View, VideoCardProps>(
  (
    {
      id,
      source,
      title,
      poster,
      year,
      rate,
      sourceName,
      progress,
      episodeIndex,
      onFocus,
      api,
      playTime = 0,
      deleteMode,
      onDeleteRecord,
    }: VideoCardProps,
    ref
  ) => {
    const router = useRouter();
    const [isFocused, setIsFocused] = useState(false);
    const [fadeAnim] = useState(new Animated.Value(0));
    const scale = useRef(new Animated.Value(1)).current;
    const deviceType = useResponsiveLayout().deviceType;

    const animatedStyle = {
      transform: [{ scale }],
    };

    const handlePress = () => {
      // 删除模式下按OK触发删除确认
      if (deleteMode && onDeleteRecord) {
        onDeleteRecord(source, id, title);
        return;
      }

      if (progress !== undefined && episodeIndex !== undefined) {
        router.push({
          pathname: "/play",
          params: { source, id, episodeIndex: episodeIndex - 1, title, position: playTime * 1000 },
        });
      } else {
        router.push({
          pathname: "/detail",
          params: { source, q: title },
        });
      }
    };

    const handleFocus = useCallback(() => {
      setIsFocused(true);
      Animated.spring(scale, {
        toValue: 1.05,
        damping: 15,
        stiffness: 200,
        useNativeDriver: true,
      }).start();
      onFocus?.();
    }, [scale, onFocus]);

    const handleBlur = useCallback(() => {
      setIsFocused(false);
      Animated.spring(scale, {
        toValue: 1.0,
        useNativeDriver: true,
      }).start();
    }, [scale]);

    useEffect(() => {
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 400,
        delay: Math.random() * 200,
        useNativeDriver: true,
      }).start();
    }, [fadeAnim]);

    const isContinueWatching = progress !== undefined && progress > 0 && progress < 1;

    return (
      <Animated.View style={[styles.wrapper, animatedStyle, { opacity: fadeAnim }]}>
        <Pressable
          android_ripple={Platform.isTV || deviceType !== 'tv' ? { color: 'transparent' } : { color: Colors.dark.link }}
          onPress={handlePress}
          onFocus={handleFocus}
          onBlur={handleBlur}
          style={({ pressed }) => [
            styles.pressable,
            {
              zIndex: pressed ? 999 : 1,
            },
          ]}
        >
          <View style={[styles.card, deleteMode && isFocused && styles.cardDeleteHighlight]}>
            <Image source={{ uri: api.getImageProxyUrl(poster) }} style={styles.poster} />
            {isFocused && !deleteMode && (
              <View style={styles.overlay}>
                {isContinueWatching && (
                  <View style={styles.continueWatchingBadge}>
                    <Play size={16} color="#ffffff" fill="#ffffff" />
                    <ThemedText style={styles.continueWatchingText}>继续观看</ThemedText>
                  </View>
                )}
              </View>
            )}
            {/* 删除模式指示 */}
            {deleteMode && isFocused && (
              <View style={styles.overlay}>
                <View style={styles.deleteBadge}>
                  <ThemedText style={styles.deleteBadgeText}>按OK删除</ThemedText>
                </View>
              </View>
            )}

            {/* 进度条 */}
            {isContinueWatching && (
              <View style={styles.progressContainer}>
                <View style={[styles.progressBar, { width: `${(progress || 0) * 100}%` }]} />
              </View>
            )}

            {rate && (
              <View style={styles.ratingContainer}>
                <Star size={12} color="#FFD700" fill="#FFD700" />
                <ThemedText style={styles.ratingText}>{rate}</ThemedText>
              </View>
            )}
            {year && (
              <View style={styles.yearBadge}>
                <Text style={styles.badgeText}>{year}</Text>
              </View>
            )}
            {sourceName && (
              <View style={styles.sourceNameBadge}>
                <Text style={styles.badgeText}>{sourceName}</Text>
              </View>
            )}
          </View>
          <View style={styles.infoContainer}>
            <ThemedText numberOfLines={1}>{title}</ThemedText>
            {isContinueWatching && (
              <View style={styles.infoRow}>
                <ThemedText style={styles.continueLabel}>
                  第{episodeIndex}集 已观看 {Math.round((progress || 0) * 100)}%
                </ThemedText>
              </View>
            )}
          </View>
        </Pressable>
      </Animated.View>
    );
  }
);

VideoCard.displayName = "VideoCard";

export default VideoCard;

const CARD_WIDTH = 160;
const CARD_HEIGHT = 240;

const styles = StyleSheet.create({
  wrapper: {
    marginHorizontal: 8,
  },
  pressable: {
    width: CARD_WIDTH + 20,
    height: CARD_HEIGHT + 60,
    justifyContent: 'center',
    alignItems: "center",
    overflow: "visible",
  },
  card: {
    marginTop: 10,
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    borderRadius: 8,
    backgroundColor: "#222",
    overflow: "hidden",
  },
  cardDeleteHighlight: {
    borderWidth: 2,
    borderColor: '#ef4444',
  },
  poster: {
    width: "100%",
    height: "100%",
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.3)",
    borderColor: Colors.dark.primary,
    borderWidth: 2,
    borderRadius: 8,
    justifyContent: "center",
    alignItems: "center",
  },
  ratingContainer: {
    position: "absolute",
    top: 8,
    right: 8,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  ratingText: {
    color: "#FFD700",
    fontSize: 12,
    fontWeight: "bold",
    marginLeft: 4,
  },
  infoContainer: {
    width: CARD_WIDTH,
    marginTop: 8,
    alignItems: "flex-start",
    marginBottom: 16,
    paddingHorizontal: 4,
  },
  infoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    width: "100%",
  },
  yearBadge: {
    position: "absolute",
    top: 8,
    right: 8,
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  sourceNameBadge: {
    position: "absolute",
    top: 8,
    left: 8,
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  badgeText: {
    color: "white",
    fontSize: 12,
    fontWeight: "bold",
  },
  progressContainer: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: 4,
    backgroundColor: "rgba(0, 0, 0, 0.8)",
  },
  progressBar: {
    height: 4,
    backgroundColor: Colors.dark.primary,
  },
  continueWatchingBadge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.dark.primary,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 5,
  },
  continueWatchingText: {
    color: "white",
    marginLeft: 5,
    fontSize: 12,
    fontWeight: "bold",
  },
  continueLabel: {
    color: Colors.dark.primary,
    fontSize: 12,
  },
  deleteBadge: {
    backgroundColor: '#ef4444',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 5,
  },
  deleteBadgeText: {
    color: "white",
    fontSize: 13,
    fontWeight: "bold",
  },
});
