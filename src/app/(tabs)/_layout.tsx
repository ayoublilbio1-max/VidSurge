import { Tabs } from "expo-router";
import CustomTabBar from "../../components/CustomTabBar";

export default function TabsLayout() {
  return (
    <Tabs
      tabBar={(props) => <CustomTabBar {...props} />}
      screenOptions={{ headerShown: false }}
    >
      <Tabs.Screen name="edit" />
      <Tabs.Screen name="lib" />
      <Tabs.Screen name="exports" />
      <Tabs.Screen name="settings" />
    </Tabs>
  );
}
