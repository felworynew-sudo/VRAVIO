export type EnvironmentKind = "raster" | "vector" | "audio" | "video";

export interface VravioDocument<TState = unknown> {
  readonly id: string;
  name: string;
  readonly kind: EnvironmentKind;
  state: TState;
  revision: number;
  dirty: boolean;
  readonly createdAt: number;
  updatedAt: number;
}

export interface Disposable {
  dispose(): void;
}

export interface CommandContext {
  readonly activeDocumentId: string | null;
}

export interface Command {
  readonly id: string;
  readonly label: string;
  readonly category: string;
  readonly shortcut?: string;
  isEnabled?(context: CommandContext): boolean;
  execute(context: CommandContext): void | Promise<void>;
}

export interface ReversibleOperation {
  readonly label: string;
  redo(): void | Promise<void>;
  undo(): void | Promise<void>;
  mergeWith?(next: ReversibleOperation): ReversibleOperation | null;
}
