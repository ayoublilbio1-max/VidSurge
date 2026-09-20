export interface ThemeColors {
  background: string;
  surface: string;
  gradientStart: string;
  gradientEnd: string;
  accentPurple: string;
  accentPurpleBright: string;
  accentPurpleDeep: string;
  accentGreen: string;
  accentGreenBright: string;
  badgeBackground: string;
  textPrimary: string;
  textMuted: string;
  iconInactive: string;
}

export const darkColors: ThemeColors = {
  background: "#0C0D17",
  surface: "#151724",
  gradientStart: "#511EE8",
  gradientEnd: "#3E12C5",
  accentPurple: "#8A42FF",
  accentPurpleBright: "#D17FFF",
  accentPurpleDeep: "#8139FF",
  accentGreen: "#2EFF80",
  accentGreenBright: "#12F95C",
  badgeBackground: "#181733",
  textPrimary: "#FFFFFF",
  textMuted: "#434663",
  iconInactive: "#27283B",
};

export const lightColors: ThemeColors = {
  background: "#F7F7FC",
  surface: "#FFFFFF",
  gradientStart: "#511EE8",
  gradientEnd: "#3E12C5",
  accentPurple: "#7B2FFF",
  accentPurpleBright: "#B24FE0",
  accentPurpleDeep: "#6B1FE0",
  accentGreen: "#00C853",
  accentGreenBright: "#00B84D",
  badgeBackground: "#EDEBFF",
  textPrimary: "#14121F",
  textMuted: "#6E7191",
  iconInactive: "#D8D9E4",
};
