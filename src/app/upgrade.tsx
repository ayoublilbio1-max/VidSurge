// Upgrade (plans) screen — VISUAL ONLY in the demo: the plans, their
// features and prices are shown, but no purchase is made (Purchase explains
// that). Opened from the home screen's "Standard" badge and the Account tab.

import { Ionicons } from "@expo/vector-icons";
import { router, Stack } from "expo-router";
import { useState, type ComponentProps } from "react";
import { ScrollView, StyleSheet, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import AppText from "../components/AppText";
import DemoFeatureModal from "../components/editor/DemoFeatureModal";
import { useTheme } from "../hooks/useTheme";

type IconName = ComponentProps<typeof Ionicons>["name"];
type PlanKey = "standard" | "pro" | "ultra";
type PriceKey = "monthly" | "yearly" | "once";

type Plan = {
  key: PlanKey;
  name: string;
  tagline: string;
  icon: IconName;
  /** Accent of the plan (hero + selected card). */
  tint: string;
  features: { icon: IconName; label: string }[];
  prices: Record<
    PriceKey,
    { price: string; was?: string; note: string; trial?: boolean }
  >;
};

const PLANS: Plan[] = [
  {
    key: "standard",
    name: "Standard",
    tagline: "Everything you need for great everyday videos",
    icon: "diamond",
    tint: "#22D3EE",
    features: [
      { icon: "film-outline", label: "2K export" },
      { icon: "water-outline", label: "No watermark" },
      { icon: "color-filter-outline", label: "Filters" },
      { icon: "mic-outline", label: "Voice record" },
      { icon: "text-outline", label: "All fonts" },
    ],
    prices: {
      monthly: { price: "$4.99", was: "$7.99", note: "per month", trial: true },
      yearly: { price: "$39.99", was: "$59.88", note: "per year", trial: true },
      once: { price: "$29.99", note: "one year, paid once" },
    },
  },
  {
    key: "pro",
    name: "Pro",
    tagline: "Advanced tools for creators who post every day",
    icon: "flash",
    tint: "#A855F7",
    features: [
      { icon: "film-outline", label: "4K 60fps export" },
      { icon: "sparkles-outline", label: "Effects" },
      { icon: "layers-outline", label: "Unlimited PIP" },
      { icon: "musical-notes-outline", label: "Music library" },
      { icon: "cloud-outline", label: "10 GB cloud" },
    ],
    prices: {
      monthly: {
        price: "$9.99",
        was: "$14.99",
        note: "per month",
        trial: true,
      },
      yearly: {
        price: "$79.99",
        was: "$119.88",
        note: "per year",
        trial: true,
      },
      once: { price: "$59.99", note: "one year, paid once" },
    },
  },
  {
    key: "ultra",
    name: "Ultra",
    tagline: "The full studio — for teams and professionals",
    icon: "rocket",
    tint: "#F59E0B",
    features: [
      { icon: "infinite-outline", label: "Everything in Pro" },
      { icon: "people-outline", label: "Team projects" },
      { icon: "cloud-outline", label: "100 GB cloud" },
      { icon: "headset-outline", label: "Priority support" },
      { icon: "color-palette-outline", label: "Brand kit" },
    ],
    prices: {
      monthly: {
        price: "$19.99",
        was: "$29.99",
        note: "per month",
        trial: true,
      },
      yearly: {
        price: "$149.99",
        was: "$239.88",
        note: "per year",
        trial: true,
      },
      once: { price: "$119.99", note: "one year, paid once" },
    },
  },
];

const PRICE_ORDER: { key: PriceKey; label: string }[] = [
  { key: "monthly", label: "Monthly" },
  { key: "yearly", label: "Yearly" },
  { key: "once", label: "One year" },
];

/** Compare plans: feature → included in Free / Standard / Pro / Ultra. */
const COMPARE: { label: string; has: [boolean, boolean, boolean, boolean] }[] =
  [
    { label: "1080P export", has: [true, true, true, true] },
    { label: "Texts, stickers, PIP", has: [true, true, true, true] },
    { label: "No watermark", has: [false, true, true, true] },
    { label: "2K export", has: [false, true, true, true] },
    { label: "Filters & voice record", has: [false, true, true, true] },
    { label: "4K 60fps export", has: [false, false, true, true] },
    { label: "Effects & music library", has: [false, false, true, true] },
    { label: "Team projects", has: [false, false, false, true] },
  ];

export default function UpgradeScreen() {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const [planKey, setPlanKey] = useState<PlanKey>("standard");
  const [priceKey, setPriceKey] = useState<PriceKey>("yearly");
  const [showCompare, setShowCompare] = useState(false);
  const [demoFeature, setDemoFeature] = useState<string | null>(null);
  const plan = PLANS.find((p) => p.key === planKey) ?? PLANS[0];
  const chosen = plan.prices[priceKey];

  const pickPlan = (key: PlanKey) => {
    if (__DEV__) console.log(`[upgrade] plan → ${key}`);
    setPlanKey(key);
  };
  const purchase = () => {
    if (__DEV__)
      console.log(
        `[upgrade] purchase pressed — ${plan.name} ${priceKey} (demo: nothing bought)`,
      );
    setDemoFeature(`The ${plan.name} subscription`);
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView
        contentContainerStyle={{ paddingBottom: 120 + insets.bottom }}
        showsVerticalScrollIndicator={false}
      >
        {/* Hero: the plan's colours, with its icon. */}
        <View
          style={[
            styles.hero,
            {
              backgroundColor: colors.gradientEnd,
              paddingTop: insets.top + 64,
            },
          ]}
        >
          <View
            style={[
              styles.blob,
              styles.blobA,
              { backgroundColor: plan.tint, opacity: 0.35 },
            ]}
          />
          <View
            style={[
              styles.blob,
              styles.blobB,
              { backgroundColor: colors.gradientStart, opacity: 0.9 },
            ]}
          />
          <View
            style={[
              styles.blob,
              styles.blobC,
              { backgroundColor: plan.tint, opacity: 0.18 },
            ]}
          />
          <View style={[styles.heroIcon, { borderColor: plan.tint }]}>
            <Ionicons name={plan.icon} size={46} color={plan.tint} />
          </View>
          <View style={styles.heroSparkles}>
            <Ionicons name="sparkles" size={18} color="#FFFFFFAA" />
          </View>
        </View>

        {/* Plan tabs, over the hero. */}
        <View style={[styles.topBar, { top: insets.top + 8 }]}>
          <TouchableOpacity
            onPress={() => router.back()}
            hitSlop={10}
            accessibilityLabel="Back"
          >
            <Ionicons name="chevron-back" size={26} color="#FFFFFF" />
          </TouchableOpacity>
          <View style={styles.planTabs}>
            {PLANS.map((p) => {
              const on = p.key === planKey;
              return (
                <TouchableOpacity
                  key={p.key}
                  onPress={() => pickPlan(p.key)}
                  hitSlop={6}
                >
                  <AppText
                    style={[
                      styles.planTab,
                      { color: on ? "#FFFFFF" : "#FFFFFF80" },
                    ]}
                  >
                    {p.name}
                  </AppText>
                  <View
                    style={[
                      styles.planTabLine,
                      { backgroundColor: on ? "#FFFFFF" : "transparent" },
                    ]}
                  />
                </TouchableOpacity>
              );
            })}
          </View>
          <View style={{ width: 26 }} />
        </View>

        <View style={styles.body}>
          <View style={styles.titleRow}>
            <Ionicons name={plan.icon} size={24} color={plan.tint} />
            <AppText style={[styles.planName, { color: colors.textPrimary }]}>
              {plan.name}
            </AppText>
          </View>
          <View style={styles.taglineRow}>
            <AppText style={[styles.tagline, { color: colors.textMuted }]}>
              {plan.tagline}
            </AppText>
          </View>
          <TouchableOpacity
            onPress={() => setShowCompare((v) => !v)}
            style={styles.compareLink}
          >
            <AppText
              style={[styles.compareText, { color: colors.accentPurple }]}
            >
              {showCompare ? "Hide comparison" : "Compare plans"}
            </AppText>
            <Ionicons
              name={showCompare ? "chevron-up" : "chevron-forward"}
              size={14}
              color={colors.accentPurple}
            />
          </TouchableOpacity>
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chips}
          style={styles.chipsBar}
        >
          {plan.features.map((f) => (
            <View
              key={f.label}
              style={[styles.chip, { backgroundColor: colors.surface }]}
            >
              <Ionicons name={f.icon} size={16} color={colors.textPrimary} />
              <AppText style={[styles.chipText, { color: colors.textPrimary }]}>
                {f.label}
              </AppText>
            </View>
          ))}
        </ScrollView>

        <View style={styles.priceRow}>
          {PRICE_ORDER.map(({ key, label }) => {
            const p = plan.prices[key];
            const on = key === priceKey;
            return (
              <TouchableOpacity
                key={key}
                activeOpacity={0.85}
                onPress={() => setPriceKey(key)}
                style={[
                  styles.priceCard,
                  {
                    backgroundColor: colors.surface,
                    borderColor: on ? plan.tint : colors.surface,
                  },
                ]}
              >
                {p.trial && (
                  <View
                    style={[
                      styles.trialBadge,
                      {
                        backgroundColor: on
                          ? plan.tint
                          : colors.badgeBackground,
                      },
                    ]}
                  >
                    <AppText
                      style={[
                        styles.trialText,
                        { color: on ? "#0C0D17" : colors.textPrimary },
                      ]}
                    >
                      7 days free
                    </AppText>
                  </View>
                )}
                <AppText
                  style={[styles.priceLabel, { color: colors.textPrimary }]}
                >
                  {label}
                </AppText>
                <AppText
                  style={[styles.priceNote, { color: colors.textMuted }]}
                >
                  {p.note}
                </AppText>
                <View style={{ flex: 1 }} />
                {p.was ? (
                  <AppText
                    style={[styles.priceWas, { color: colors.textMuted }]}
                  >
                    {p.was}
                  </AppText>
                ) : null}
                <AppText style={[styles.price, { color: colors.textPrimary }]}>
                  {p.price}
                </AppText>
              </TouchableOpacity>
            );
          })}
        </View>

        {showCompare && (
          <View style={[styles.compare, { backgroundColor: colors.surface }]}>
            <View style={styles.compareRow}>
              <AppText
                style={[styles.compareFeature, { color: colors.textMuted }]}
              >
                {" "}
              </AppText>
              {["Free", "Std", "Pro", "Ultra"].map((h) => (
                <AppText
                  key={h}
                  style={[styles.compareHead, { color: colors.textPrimary }]}
                >
                  {h}
                </AppText>
              ))}
            </View>
            {COMPARE.map((row) => (
              <View key={row.label} style={styles.compareRow}>
                <AppText
                  style={[styles.compareFeature, { color: colors.textPrimary }]}
                >
                  {row.label}
                </AppText>
                {row.has.map((ok, i) => (
                  <View key={i} style={styles.compareCell}>
                    <Ionicons
                      name={ok ? "checkmark-circle" : "remove"}
                      size={18}
                      color={ok ? colors.accentGreen : colors.textMuted}
                    />
                  </View>
                ))}
              </View>
            ))}
          </View>
        )}

        <View
          style={[styles.offer, { backgroundColor: colors.badgeBackground }]}
        >
          <Ionicons
            name="gift-outline"
            size={20}
            color={colors.accentPurpleBright}
          />
          <AppText style={[styles.offerText, { color: colors.textPrimary }]}>
            Try any plan free for 7 days — cancel anytime
          </AppText>
        </View>
      </ScrollView>

      {/* Purchase, always visible at the bottom. */}
      <View
        style={[
          styles.footer,
          {
            backgroundColor: colors.background,
            paddingBottom: 12 + insets.bottom,
          },
        ]}
      >
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={purchase}
          style={[styles.purchase, { backgroundColor: plan.tint }]}
        >
          <AppText style={styles.purchaseText}>
            {chosen.trial ? "Start free trial" : `Buy for ${chosen.price}`}
          </AppText>
        </TouchableOpacity>
        <AppText style={[styles.legal, { color: colors.textMuted }]}>
          {chosen.trial
            ? `7 days free, then ${chosen.price} ${chosen.note}. `
            : ""}
          Demo version — no payment is taken.
        </AppText>
      </View>

      <DemoFeatureModal
        feature={demoFeature}
        onClose={() => setDemoFeature(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  hero: {
    height: 330,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  blob: { position: "absolute", borderRadius: 999 },
  blobA: { width: 320, height: 320, top: -80, right: -120 },
  blobB: { width: 260, height: 260, bottom: -110, left: -70 },
  blobC: { width: 180, height: 180, bottom: 30, right: 40 },
  heroIcon: {
    width: 104,
    height: 104,
    borderRadius: 32,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FFFFFF14",
    marginTop: 20,
  },
  heroSparkles: { position: "absolute", top: 150, right: 120 },
  topBar: {
    position: "absolute",
    left: 16,
    right: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  planTabs: { flexDirection: "row", gap: 24 },
  planTab: { fontSize: 17, fontFamily: "Poppins-Bold", lineHeight: 24 },
  planTabLine: {
    height: 3,
    borderRadius: 2,
    marginTop: 2,
    alignSelf: "center",
    width: 18,
  },
  body: { paddingHorizontal: 20, paddingTop: 18 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  planName: { fontSize: 26, fontFamily: "Poppins-Bold", lineHeight: 34 },
  taglineRow: { marginTop: 4 },
  tagline: { fontSize: 14, lineHeight: 20 },
  compareLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 6,
    alignSelf: "flex-start",
  },
  compareText: { fontSize: 14, fontFamily: "Poppins-Medium" },
  chipsBar: { flexGrow: 0, flexShrink: 0, height: 60 },
  chips: { paddingHorizontal: 20, gap: 8, alignItems: "center" },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 40,
    paddingHorizontal: 14,
    borderRadius: 12,
  },
  chipText: { fontSize: 14, lineHeight: 20 },
  priceRow: {
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 20,
    marginTop: 14,
  },
  priceCard: {
    flex: 1,
    height: 150,
    borderRadius: 16,
    borderWidth: 2,
    padding: 12,
    paddingTop: 22,
  },
  trialBadge: {
    position: "absolute",
    top: -11,
    left: 10,
    paddingHorizontal: 8,
    height: 22,
    borderRadius: 8,
    justifyContent: "center",
  },
  trialText: { fontSize: 11, fontFamily: "Poppins-Medium", lineHeight: 16 },
  priceLabel: { fontSize: 15, fontFamily: "Poppins-Bold", lineHeight: 22 },
  priceNote: { fontSize: 12, lineHeight: 16, marginTop: 2 },
  priceWas: {
    fontSize: 12,
    textDecorationLine: "line-through",
    lineHeight: 16,
  },
  price: { fontSize: 22, fontFamily: "Poppins-Bold", lineHeight: 30 },
  compare: {
    marginHorizontal: 20,
    marginTop: 16,
    borderRadius: 16,
    padding: 12,
    gap: 8,
  },
  compareRow: { flexDirection: "row", alignItems: "center" },
  compareFeature: { flex: 1, fontSize: 13, lineHeight: 18 },
  compareHead: {
    width: 44,
    textAlign: "center",
    fontSize: 12,
    fontFamily: "Poppins-Bold",
  },
  compareCell: { width: 44, alignItems: "center" },
  offer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: 20,
    marginTop: 18,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 14,
  },
  offerText: { flex: 1, fontSize: 13, lineHeight: 18 },
  footer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 20,
    paddingTop: 10,
  },
  purchase: {
    height: 54,
    borderRadius: 27,
    alignItems: "center",
    justifyContent: "center",
  },
  purchaseText: { fontSize: 17, fontFamily: "Poppins-Bold", color: "#0C0D17" },
  legal: { fontSize: 11, lineHeight: 16, textAlign: "center", marginTop: 8 },
});
