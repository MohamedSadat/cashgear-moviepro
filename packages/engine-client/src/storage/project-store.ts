import { transaction } from './database';

/** A project the app knows about: the recent list on desktop, all projects on the web. */
export interface ProjectEntry {
  id: string;
  name: string;
  /** Desktop: the project file. Web projects live in browser storage and have none. */
  path?: string;
  /** When the project file was last written, in milliseconds. Unset until the first save. */
  savedAt?: number;
  openedAt: number;
}

/** The project list, in IndexedDB. */
export const projectIndex = {
  /** Most recently opened first. */
  async list(): Promise<ProjectEntry[]> {
    const all = await transaction<ProjectEntry[]>('projects', 'readonly', (store) =>
      store.getAll(),
    );
    return all.sort((a, b) => b.openedAt - a.openedAt);
  },
  async put(entry: ProjectEntry) {
    await transaction('projects', 'readwrite', (store) => store.put(entry));
  },
  async remove(id: string) {
    await transaction('projects', 'readwrite', (store) => store.delete(id));
  },
};

export type ProjectFileName = 'project' | 'autosave';

async function folder(id: string, create: boolean) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error(`Invalid project id ${id}`);
  const root = await navigator.storage.getDirectory();
  const projects = await root.getDirectoryHandle('projects', { create });
  return projects.getDirectoryHandle(id, { create });
}

const notFound = (error: unknown) =>
  error instanceof DOMException &&
  (error.name === 'NotFoundError' || error.name === 'TypeMismatchError');

/**
 * Web project files in the origin-private file system: `projects/<id>/project.cgvproj`
 * is the saved project and `projects/<id>/autosave.cgvproj` the autosave. Writes
 * replace a file only when they complete.
 */
export const opfsProjectFiles = {
  async read(
    id: string,
    name: ProjectFileName,
  ): Promise<{ text: string; modified: number } | null> {
    try {
      const file = await (
        await (await folder(id, false)).getFileHandle(`${name}.cgvproj`)
      ).getFile();
      return { text: await file.text(), modified: file.lastModified };
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
  },
  async write(id: string, name: ProjectFileName, text: string) {
    const handle = await (
      await folder(id, true)
    ).getFileHandle(`${name}.cgvproj`, { create: true });
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
  },
  async remove(id: string, name: ProjectFileName) {
    try {
      await (await folder(id, false)).removeEntry(`${name}.cgvproj`);
    } catch (error) {
      if (!notFound(error)) throw error;
    }
  },
  /** Deletes the project's folder. */
  async removeAll(id: string) {
    try {
      const root = await navigator.storage.getDirectory();
      await (await root.getDirectoryHandle('projects')).removeEntry(id, { recursive: true });
    } catch (error) {
      if (!notFound(error)) throw error;
    }
  },
};
