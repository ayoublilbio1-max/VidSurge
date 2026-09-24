import { File, Paths } from "expo-file-system";

export interface ProjectItem {
  id: string;
  name: string;
  createdAt: number;
  thumbnailUri?: string;
}

const projectsFile = new File(Paths.document, "projects.json");

export async function loadProjects(): Promise<ProjectItem[]> {
  try {
    if (!projectsFile.exists) {
      return [];
    }
    const content = await projectsFile.text();
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn("Failed to load projects:", error);
    return [];
  }
}

export async function saveProjects(projects: ProjectItem[]): Promise<void> {
  try {
    if (!projectsFile.exists) {
      projectsFile.create();
    }
    projectsFile.write(JSON.stringify(projects));
  } catch (error) {
    console.warn("Failed to save projects:", error);
  }
}

export async function addProject(project: ProjectItem): Promise<void> {
  const projects = await loadProjects();
  projects.unshift(project);
  await saveProjects(projects);
}
