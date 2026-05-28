import React from "react";
import { View, Text, StyleSheet, Modal, FlatList } from "react-native";
import { StyledButton } from "./StyledButton";
import useDetailStore, { SearchResultWithResolution, getSourceScore } from "@/stores/detailStore";
import usePlayerStore from "@/stores/playerStore";
import Logger from '@/utils/Logger';

const logger = Logger.withTag('SourceSelectionModal');

const getSpeedLabel = (item: SearchResultWithResolution) => {
  if (item.probeResult?.accessible) {
    const ping = item.probeResult.pingMs;
    if (ping < 200) return '极快';
    if (ping < 500) return '快';
    if (ping < 1000) return '中';
    return '慢';
  }
  if (item.probeResult && !item.probeResult.accessible) return '不可用';
  return '';
};

const getSpeedColor = (item: SearchResultWithResolution) => {
  if (item.probeResult?.accessible) {
    const ping = item.probeResult.pingMs;
    if (ping < 500) return '#4ade80';
    if (ping < 1000) return '#facc15';
    return '#fb923c';
  }
  if (item.probeResult && !item.probeResult.accessible) return '#ef4444';
  return '#888';
};

export const SourceSelectionModal: React.FC = () => {
  const { showSourceModal, setShowSourceModal, loadVideo, currentEpisodeIndex, status } = usePlayerStore();
  const { searchResults, detail, setDetail } = useDetailStore();

  const sortedResults = [...searchResults].sort((a, b) => getSourceScore(b) - getSourceScore(a));

  const onSelectSource = (item: SearchResultWithResolution) => {
    logger.debug("onSelectSource", item.source, detail?.source);
    if (item.source !== detail?.source) {
      setDetail(item);
      const currentPosition = status?.isLoaded ? status.positionMillis : undefined;
      loadVideo({
        source: item.source,
        id: item.id.toString(),
        episodeIndex: currentEpisodeIndex,
        title: item.title,
        position: currentPosition
      });
    }
    setShowSourceModal(false);
  };

  const onClose = () => {
    setShowSourceModal(false);
  };

  const renderItem = ({ item }: { item: SearchResultWithResolution }) => {
    const isSelected = detail?.source === item.source;
    const isCurrentPlaying = isSelected;
    const speedLabel = getSpeedLabel(item);
    const speedColor = getSpeedColor(item);

    return (
      <StyledButton
        onPress={() => onSelectSource(item)}
        isSelected={isSelected}
        hasTVPreferredFocus={isCurrentPlaying}
        style={styles.sourceItem}
      >
        <View style={styles.sourceItemContent}>
          <Text style={[styles.sourceName, isSelected && styles.sourceNameSelected]} numberOfLines={1}>
            {isCurrentPlaying ? '▸ ' : ''}{item.source_name}
          </Text>
          <View style={styles.badgeRow}>
            {item.episodes.length > 1 && (
              <View style={[styles.badge, { backgroundColor: "#555" }]}>
                <Text style={styles.badgeText}>{item.episodes.length > 99 ? "99+" : item.episodes.length}集</Text>
              </View>
            )}
            {speedLabel ? (
              <View style={[styles.badge, { backgroundColor: "rgba(0,0,0,0.6)" }]}>
                <Text style={[styles.badgeText, { color: speedColor }]}>{speedLabel}</Text>
              </View>
            ) : null}
            {item.resolution && (
              <View style={[styles.badge, { backgroundColor: "#666" }]}>
                <Text style={styles.badgeText}>{item.resolution}</Text>
              </View>
            )}
          </View>
        </View>
      </StyledButton>
    );
  };

  return (
    <Modal visible={showSourceModal} transparent={true} animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalContainer}>
        <View style={styles.modalContent}>
          <Text style={styles.modalTitle}>选择播放源 ({searchResults.length})</Text>
          <FlatList
            data={sortedResults}
            numColumns={3}
            contentContainerStyle={styles.sourceList}
            keyExtractor={(item) => `source-${item.source}`}
            renderItem={renderItem}
          />
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  modalContainer: {
    flex: 1,
    flexDirection: "row",
    justifyContent: "flex-end",
    backgroundColor: "transparent",
  },
  modalContent: {
    width: 600,
    height: "100%",
    backgroundColor: "rgba(0, 0, 0, 0.85)",
    padding: 20,
  },
  modalTitle: {
    color: "white",
    marginBottom: 12,
    textAlign: "center",
    fontSize: 18,
    fontWeight: "bold",
  },
  sourceList: {
    justifyContent: "flex-start",
  },
  sourceItem: {
    paddingVertical: 2,
    margin: 4,
    marginLeft: 10,
    marginRight: 8,
    width: "30%",
  },
  sourceItemContent: {
    flexDirection: "column",
    alignItems: "flex-start",
  },
  sourceName: {
    color: "white",
    fontSize: 14,
    fontWeight: "500",
  },
  sourceNameSelected: {
    color: "#fff",
    fontWeight: "bold",
  },
  badgeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginTop: 2,
  },
  badge: {
    borderRadius: 8,
    paddingHorizontal: 5,
    paddingVertical: 1,
    marginRight: 4,
    marginTop: 2,
  },
  badgeText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "bold",
  },
});
