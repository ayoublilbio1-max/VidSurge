import { router } from "expo-router";
import { useRef, useState } from "react";
import {
  Dimensions,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  View,
} from "react-native";
import AppText from "../components/AppText";
import { useTheme } from "../hooks/useTheme";
import { saveOnboardingAnswers } from "../lib/onboardingStorage";

const { width } = Dimensions.get("window");

type Colors = ReturnType<typeof useTheme>;

const CONTENT_TYPE_OPTIONS = [
  { key: "vlogs", emoji: "🏠", label: "Vlogs & daily life" },
  { key: "promo", emoji: "📣", label: "Promo & marketing" },
  { key: "social", emoji: "🔥", label: "Social media content" },
  { key: "tutorials", emoji: "🎓", label: "Tutorials & education" },
  { key: "hobbies", emoji: "🎨", label: "Hobbies & entertainment" },
  { key: "other", emoji: "👤", label: "Other" },
];

const USAGE_OPTIONS = [
  { key: "trim", emoji: "✂️", label: "Trim, cut & split clips" },
  { key: "music", emoji: "🎵", label: "Add music & sound" },
  { key: "text", emoji: "💬", label: "Add text & captions" },
  { key: "filters", emoji: "🎨", label: "Apply filters & effects" },
];

export default function Onboarding() {
  const colors = useTheme();
  const scrollRef = useRef<ScrollView>(null);
  const [page, setPage] = useState(0);
  const [contentType, setContentType] = useState<string | null>(null);
  const [usage, setUsage] = useState<string | null>(null);

  const goToPage = (index: number) => {
    scrollRef.current?.scrollTo({ x: index * width, animated: true });
    setPage(index);
  };

  const finishOnboarding = async () => {
    await saveOnboardingAnswers(contentType, usage);
    router.replace("/");
  };

  const handleMomentumScrollEnd = (
    e: NativeSyntheticEvent<NativeScrollEvent>,
  ) => {
    const newPage = Math.round(e.nativeEvent.contentOffset.x / width);
    setPage(newPage);
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View style={styles.topBar}>
        <TouchableOpacity
          onPress={() => page === 1 && goToPage(0)}
          style={styles.backButton}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          {page === 1 && (
            <AppText style={[styles.backArrow, { color: colors.textMuted }]}>
              ‹
            </AppText>
          )}
        </TouchableOpacity>

        <AppText style={[styles.progressLabel, { color: colors.textMuted }]}>
          {page + 1}/2
        </AppText>

        <TouchableOpacity
          onPress={finishOnboarding}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <AppText style={[styles.skip, { color: colors.textMuted }]}>
            Skip
          </AppText>
        </TouchableOpacity>
      </View>

      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={handleMomentumScrollEnd}
      >
        <View style={{ width }}>
          <OnboardingPage
            title="What type of content do you want to create?"
            options={CONTENT_TYPE_OPTIONS}
            selected={contentType}
            onSelect={setContentType}
            colors={colors}
          />
        </View>
        <View style={{ width }}>
          <OnboardingPage
            title="What will you use VidSurge for?"
            options={USAGE_OPTIONS}
            selected={usage}
            onSelect={setUsage}
            colors={colors}
          />
        </View>
      </ScrollView>

      <View style={styles.bottomArea}>
        <TouchableOpacity
          style={[styles.ctaButton, { backgroundColor: colors.accentPurple }]}
          onPress={() => (page === 0 ? goToPage(1) : finishOnboarding())}
        >
          <AppText style={styles.ctaText}>
            {page === 0 ? "Next" : "Start creating"}
          </AppText>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function OnboardingPage({
  title,
  options,
  selected,
  onSelect,
  colors,
}: {
  title: string;
  options: { key: string; emoji: string; label: string }[];
  selected: string | null;
  onSelect: (key: string) => void;
  colors: Colors;
}) {
  return (
    <View style={styles.page}>
      <AppText style={[styles.title, { color: colors.textPrimary }]}>
        {title}
      </AppText>

      <View style={styles.optionsList}>
        {options.map((opt) => {
          const isSelected = selected === opt.key;
          return (
            <TouchableOpacity
              key={opt.key}
              style={[
                styles.optionRow,
                {
                  backgroundColor: colors.surface,
                  borderColor: isSelected ? colors.accentPurple : "transparent",
                },
              ]}
              onPress={() => onSelect(opt.key)}
            >
              <AppText style={styles.optionEmoji}>{opt.emoji}</AppText>
              <AppText
                style={[styles.optionLabel, { color: colors.textPrimary }]}
              >
                {opt.label}
              </AppText>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingTop: 56 },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    marginBottom: 8,
  },
  backButton: { width: 32 },
  backArrow: { fontSize: 28 },
  progressLabel: { fontSize: 15, fontFamily: "Poppins-Medium" },
  skip: { fontSize: 15 },
  page: { paddingHorizontal: 24, paddingTop: 24 },
  title: {
    fontSize: 28,
    fontFamily: "Poppins-Bold",
    lineHeight: 34,
    marginBottom: 28,
  },
  optionsList: { gap: 14 },
  optionRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 18,
    paddingHorizontal: 18,
    borderRadius: 16,
    borderWidth: 2,
  },
  optionEmoji: { fontSize: 20, marginRight: 14 },
  optionLabel: { fontSize: 16, fontFamily: "Poppins-Medium" },
  bottomArea: { paddingHorizontal: 20, paddingBottom: 32, marginTop: "auto" },
  ctaButton: { paddingVertical: 18, borderRadius: 16, alignItems: "center" },
  ctaText: { color: "#FFFFFF", fontSize: 16, fontFamily: "Poppins-Bold" },
});
