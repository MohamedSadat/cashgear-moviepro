import type { Command, EngineClient, Preview, ProjectSnapshot } from '@cgv/engine-client';

/**
 * One drag or slider gesture: a single undo step. Each step sends the whole
 * gesture so far, and the engine applies it from where the gesture began. Steps
 * are coalesced, so a slow engine is sent only the latest.
 */
export class Gesture {
  private started: Promise<void>;
  private inFlight: Promise<void> | null = null;
  private pending: Command | null = null;
  private closed = false;
  /** Why the latest step could not apply, if it could not. */
  error: string | null = null;

  constructor(
    private readonly api: EngineClient['api'],
    label: string,
    private readonly onSnapshot: (snapshot: ProjectSnapshot, preview: Preview) => void,
  ) {
    this.started = Promise.resolve(api.projectBeginGroup(label));
  }

  /** Shows `command` as the gesture's current step. */
  step(command: Command) {
    if (this.closed) return;
    this.pending = command;
    if (!this.inFlight) this.inFlight = this.flush();
  }

  private async flush() {
    await this.started;
    while (this.pending && !this.closed) {
      const command = this.pending;
      this.pending = null;
      const preview = await this.api.projectPreview(command);
      this.error = preview.error;
      if (!this.closed) this.onSnapshot(preview.snapshot, preview);
    }
    this.inFlight = null;
  }

  /** Keeps the last step that applied as one undo step. */
  async end(): Promise<ProjectSnapshot> {
    await this.settle();
    this.closed = true;
    return this.api.projectEndGroup();
  }

  /** Reverts everything the gesture did. */
  async cancel(): Promise<ProjectSnapshot> {
    this.pending = null;
    await this.settle();
    this.closed = true;
    return this.api.projectCancelGroup();
  }

  private async settle() {
    await this.started;
    while (this.inFlight) await this.inFlight;
  }
}
