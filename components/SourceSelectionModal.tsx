import React from "react";
import { View, Text, StyleSheet, Modal, FlatList } from "react-native";
import { StyledButton } from "./StyledButton";
import useDetailStore, { SearchResultWithResolution } from "@/stores/detailStore";
import usePlayerStore from "@/stores/playerStore";
import { ThemedText } from "./ThemedText";
import Logger from '@/utils/Logger';

const logger = Logger.withTag('SourceSelectionModal');

// 计算源的评分（越高越好）
const getSourceScore = (item: SearchResultWithResolution): number => {
  let score = 0;
  const probe = item.probeResult;

  // 可访问性最重要
  if (probe?.accessible) {
    score += 1000;
    // ping越低越好（最高+500，最低+0）
    if (probe.pingMs < 200) score += 500;
    else if (probe.pingMs < 500) score += 400;
    else if (probe.pingMs < 1000) score += 300;
    else if (probe.pingMs < 2000) score += 200;
    else score += 100;
  } else if (probe && !probe.accessible) {
    // 明确不可访问，低分
    score -= 500;
  }
  // 没有probe结果的源，给中等基础分（可能还没probe完）
  else {
    score += 100;
  }

  // 分辨率加分
  const res = item.resolution || '';
  if (res.includes('1080')) score += 40;
  else if (res.includes('720')) score += 30;
  else if (res.includes('480')) score += 20;
  else if (res.includes('360')) score += 10;

  return score;
};

export const SourceSelectionModal: React.FC = () => {
  const { showSourceModal, setShowSourceModal, loadVideo, currentEpisodeIndex, status } = usePlayerStore();
  const { searchResults, detail, setDetail } = useDetailStore();

  const onSelectSource = (sourceItem: SearchResultWithResolution) => {
    if (sourceItem.source !== detail?.source) {
      setDetail(sourceItem);

      const currentPosition = status?.isLoaded ? status.positionMillis : undefined;
      loadVideo({
        source: sourceItem.source,
        id: sourceItem.id.toString(),
        episodeIndex: currentEpisodeIndex,
        title: sourceItem.title,
        position: currentPosition
      });
    }
    setShowSourceModal(false);
  };

  const onClose = () => {
    setShowSourceModal(false);
  };

  // 按评分从高到低排序
  const sortedResults = [...searchResults].sort((a, b) => getSourceScore(b) - getSourceScore(a));

  const getSourceLabel = (item: SearchResultWithResolution) => {
    const parts = [item.source_name];

    if (item.probeResult?.accessible) {
      const ping = item.probeResult.pingMs;
      if (ping < 200) parts.push('极快');
      else if (ping < 500) parts.push('快');
      else if (ping < 1000) parts.push('中');
      else parts.push('慢');
    } else if (item.probeResult && !item.probeResult.accessible) {
      parts.push('不可用');
    }

    if (item.resolution) {
      parts.push(item.resolution);
    }

    return parts.join(' · ');
  };

  const getLabelColor = (item: SearchResultWithResolution) => {
    if (item.probeResult?.accessible) {
      const ping = item.probeResult.pingMs;
      if (ping < 500) return '#4ade80'; // 绿色 - 快
      if (ping < 1000) return '#facc15'; // 黄色 - 中
      return '#fb923c'; // 橙色 - 慢
    }
    if (item.probeResult && !item.probeResult.accessible) {
      return '#ef4444'; // 红色 - 不可用
    }
    return 'rgba(255,255,255,0.5)'; // 灰色 - 未检测
  };

  return (
    <Modal visible={showSourceModal} transparent={true} animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalContainer}>
        <View style={styles.modalContent}>
          <View style={styles.titleRow}>
            <Text style={styles.modalTitle}>选择播放源</Text>
            <ThemedText style={styles.subtitle}>按质量排序</ThemedText>
          </View>
          <FlatList
            data={sortedResults}
            numColumns={2}
            contentContainerStyle={styles.sourceList}
            keyExtractor={(item, index) => `source-${item.source}-${index}`}
            renderItem={({ item }) => {
              const isSelected = detail?.source === item.source;
              const label = getSourceLabel(item);
              const labelColor = getLabelColor(item);

              return (
                <View style={styles.sourceItemWrapper}>
                  <StyledButton
                    text={label}
                    onPress={() => onSelectSource(item)}
                    isSelected={isSelected}
                    hasTVPreferredFocus={isSelected}
                    style={styles.sourceItem}
                    textStyle={[styles.sourceItemText, { color: labelColor }]}
                  />
                </View>
              );
            }}
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
  titleRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "center",
    marginBottom: 12,
    gap: 10,
  },
  modalTitle: {
    color: "white",
    textAlign: "center",
    fontSize: 18,
    fontWeight: "bold",
  },
  subtitle: {
    fontSize: 12,
    opacity: 0.5,
  },
  sourceList: {
    justifyContent: "flex-start",
  },
  sourceItemWrapper: {
    width: "50%",
    padding: 4,
  },
  sourceItem: {
    paddingVertical: 2,
    margin: 2,
  },
  sourceItemText: {
    fontSize: 13,
  },
});
