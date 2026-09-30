import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import {
    Alert,
    Modal,
    Pressable,
    StyleSheet,
    TextInput,
    TouchableOpacity,
    View,
} from "react-native";
import { useTheme } from "../hooks/useTheme";
import type { ProjectItem } from "../lib/projectsStorage";
import AppText from "./AppText";

/**
 * Long press / ⋮ on a recent project: Rename or Delete it.
 * Rename switches the card to a text field; Delete asks first.
 */
export default function ProjectOptionsModal({
  project,
  onClose,
  onRename,
  onDelete,
}: {
  /** The project, or null when hidden. */
  project: ProjectItem | null;
  onClose: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}) {
  const colors = useTheme();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");

  // Fresh state every time it opens.
  useEffect(() => {
    setRenaming(false);
    setName(project?.name ?? "");
  }, [project?.id]);

  if (!project) return null;

  const confirmDelete = () => {
    Alert.alert(
      "Delete project?",
      `"${project.name}" will be deleted. This can't be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => onDelete(project.id),
        },
      ],
    );
  };

  const submitRename = () => {
    const clean = name.trim();
    if (!clean) return;
    onRename(project.id, clean);
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable
          style={[styles.card, { backgroundColor: colors.background }]}
        >
          {renaming ? (
            <>
              <AppText style={[styles.title, { color: colors.textPrimary }]}>
                Rename project
              </AppText>
              <TextInput
                value={name}
                onChangeText={setName}
                autoFocus
                selectTextOnFocus
                maxLength={60}
                returnKeyType="done"
                onSubmitEditing={submitRename}
                placeholder="Project name"
                placeholderTextColor={colors.textMuted}
                style={[
                  styles.input,
                  {
                    backgroundColor: colors.surface,
                    color: colors.textPrimary,
                  },
                ]}
              />
              <View style={styles.buttonsRow}>
                <TouchableOpacity
                  onPress={() => setRenaming(false)}
                  style={[styles.button, { backgroundColor: colors.surface }]}
                >
                  <AppText
                    style={[styles.buttonText, { color: colors.textPrimary }]}
                  >
                    Cancel
                  </AppText>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={submitRename}
                  disabled={!name.trim()}
                  style={[
                    styles.button,
                    {
                      backgroundColor: colors.accentPurple,
                      opacity: name.trim() ? 1 : 0.5,
                    },
                  ]}
                >
                  <AppText style={[styles.buttonText, { color: "#FFFFFF" }]}>
                    Save
                  </AppText>
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <>
              <AppText
                numberOfLines={1}
                style={[styles.title, { color: colors.textPrimary }]}
              >
                {project.name}
              </AppText>
              <TouchableOpacity
                style={[styles.option, { backgroundColor: colors.surface }]}
                onPress={() => setRenaming(true)}
              >
                <Ionicons
                  name="create-outline"
                  size={20}
                  color={colors.textPrimary}
                />
                <AppText
                  style={[styles.optionText, { color: colors.textPrimary }]}
                >
                  Rename
                </AppText>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.option, { backgroundColor: colors.surface }]}
                onPress={confirmDelete}
              >
                <Ionicons name="trash-outline" size={20} color="#FF5A5F" />
                <AppText style={[styles.optionText, { color: "#FF5A5F" }]}>
                  Delete
                </AppText>
              </TouchableOpacity>
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center",
    justifyContent: "center",
    padding: 28,
  },
  card: {
    width: "100%",
    maxWidth: 360,
    borderRadius: 18,
    padding: 18,
    gap: 10,
  },
  title: { fontSize: 17, fontFamily: "Poppins-Bold", marginBottom: 4 },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: 12,
    paddingVertical: 13,
    paddingHorizontal: 14,
  },
  optionText: { fontSize: 15, fontFamily: "Poppins-Medium" },
  input: {
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontSize: 15,
  },
  buttonsRow: { flexDirection: "row", gap: 10, marginTop: 4 },
  button: {
    flex: 1,
    height: 42,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: { fontSize: 15, fontFamily: "Poppins-Medium" },
});
