import { useColorScheme } from "react-native";
import { darkColors, lightColors, ThemeColors } from "../constants/colors";

export function useTheme(): ThemeColors {
  const scheme = useColorScheme(); // 'dark' | 'light' | null
  return scheme === "light" ? lightColors : darkColors;
}
