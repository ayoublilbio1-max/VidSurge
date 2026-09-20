import { File, Paths } from "expo-file-system";

export interface OnboardingAnswers {
  completed: boolean;
  contentType: string | null;
  usage: string | null;
}

function getOnboardingFile() {
  return new File(Paths.document, "onboarding.json");
}

export async function hasCompletedOnboarding(): Promise<boolean> {
  try {
    const file = getOnboardingFile();
    if (!file.exists) return false;
    const raw = await file.text();
    const data: OnboardingAnswers = JSON.parse(raw);
    return data.completed === true;
  } catch {
    return false;
  }
}

export async function saveOnboardingAnswers(
  contentType: string | null,
  usage: string | null,
): Promise<void> {
  const data: OnboardingAnswers = { completed: true, contentType, usage };
  const file = getOnboardingFile();
  if (!file.exists) {
    file.create();
  }
  file.write(JSON.stringify(data));
}
