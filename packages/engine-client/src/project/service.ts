import { ProjectSession, media_ref } from '../pkg/cgv_wasm';
import type { MediaItem } from '../media/types';
import type {
  ClipAt,
  Command,
  MediaRef,
  Outcome,
  Preset,
  Preview,
  ProjectSnapshot,
  SavedText,
} from './types';

/**
 * The engine worker's open project (Rust, via WASM). Every change is a command;
 * each call answers with the snapshot the UI renders.
 */
export class ProjectService {
  private session: ProjectSession | null = null;
  /** Told after every change; `replaced` when another project (or none) is open. */
  onChange: (replaced: boolean) => void = () => {};

  /** The open project's session, for playback. */
  get current(): ProjectSession | null {
    return this.session;
  }

  create(id: string, name: string): ProjectSnapshot {
    return this.replace(new ProjectSession(id, name));
  }

  /** Opens `.cgvproj` text. `recovered` marks an autosave; `id` makes an imported copy. */
  open(text: string, options: { recovered?: boolean; id?: string } = {}): ProjectSnapshot {
    return this.replace(ProjectSession.open(text, options.recovered ?? false, options.id));
  }

  close() {
    const open = this.session !== null;
    this.session?.free();
    this.session = null;
    if (open) this.onChange(true);
  }

  snapshot(): ProjectSnapshot {
    return JSON.parse(this.require().snapshot());
  }

  execute(command: Command): { outcome: Outcome; snapshot: ProjectSnapshot } {
    const outcome = JSON.parse(this.require().execute(JSON.stringify(command))) as Outcome;
    this.onChange(false);
    return { outcome, snapshot: this.snapshot() };
  }

  /** Runs several commands as one undo step. Stops at the first failure and undoes the rest. */
  executeGroup(
    label: string,
    commands: Command[],
  ): { outcomes: Outcome[]; snapshot: ProjectSnapshot } {
    const session = this.require();
    session.begin_group(label);
    const outcomes: Outcome[] = [];
    try {
      for (const command of commands)
        outcomes.push(JSON.parse(session.execute(JSON.stringify(command))));
    } catch (error) {
      session.cancel_group();
      this.onChange(false);
      throw error;
    }
    session.end_group();
    this.onChange(false);
    return { outcomes, snapshot: this.snapshot() };
  }

  undo(): ProjectSnapshot {
    this.require().undo();
    this.onChange(false);
    return this.snapshot();
  }

  redo(): ProjectSnapshot {
    this.require().redo();
    this.onChange(false);
    return this.snapshot();
  }

  beginGroup(label: string) {
    this.require().begin_group(label);
  }

  /**
   * One step of a gesture inside a group: replaces what the group has done with
   * `command`. A step that cannot apply keeps the previous one and says why.
   */
  preview(command: Command): Preview {
    const session = this.require();
    try {
      const outcome = JSON.parse(session.preview(JSON.stringify(command))) as Outcome;
      this.onChange(false);
      return { outcome, error: null, snapshot: this.snapshot() };
    } catch (error) {
      return { outcome: null, error: String(error), snapshot: this.snapshot() };
    }
  }

  endGroup(): ProjectSnapshot {
    this.require().end_group();
    this.onChange(false);
    return this.snapshot();
  }

  cancelGroup(): ProjectSnapshot {
    this.require().cancel_group();
    this.onChange(false);
    return this.snapshot();
  }

  /** The project file's text for the current state. */
  save(): SavedText {
    const session = this.require();
    return { text: session.save(), generation: session.generation() };
  }

  markSaved(generation: number): ProjectSnapshot {
    this.require().mark_saved(generation);
    return this.snapshot();
  }

  markAutosaved(generation: number): ProjectSnapshot {
    this.require().mark_autosaved(generation);
    return this.snapshot();
  }

  /** Records a relinked or changed file. Not an undo step; leaves unsaved changes. */
  updateMedia(media: MediaRef): ProjectSnapshot {
    this.require().update_media(JSON.stringify(media));
    this.onChange(false);
    return this.snapshot();
  }

  clipsAt(time: number): ClipAt[] {
    return JSON.parse(this.require().clips_at(time));
  }

  snapPoints(playhead: number | null, exclude: number[]): number[] {
    return JSON.parse(this.require().snap_points(playhead ?? undefined, JSON.stringify(exclude)));
  }

  static presets(): Preset[] {
    return JSON.parse(ProjectSession.presets());
  }

  /** The project's reference to a library item. */
  static mediaRef(item: MediaItem, modified: number | null): MediaRef {
    return JSON.parse(media_ref(JSON.stringify(item), modified ?? undefined));
  }

  private replace(session: ProjectSession): ProjectSnapshot {
    this.session?.free();
    this.session = session;
    this.onChange(true);
    return this.snapshot();
  }

  private require(): ProjectSession {
    if (!this.session) throw new Error('No project is open');
    return this.session;
  }
}
