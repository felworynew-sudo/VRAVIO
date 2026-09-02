import type { AssetId } from "./asset-store";
import { AssetStore } from "./asset-store";
import type { DocumentStore } from "./document-store";
import { EnvironmentRegistry } from "./environment";
import { EventBus } from "./event-bus";
import type { HistoryManager } from "./history-manager";
import type { Disposable, EnvironmentKind, ParentTarget, VravioDocument } from "./types";

export interface RoundTripRequest {
  readonly parentDocId: string;
  readonly target: ParentTarget;
  /** Which kind of editor to open the extracted material in. */
  readonly targetEnv: EnvironmentKind;
  /** Extra material either side of the target, for editors that need context. */
  readonly handles?: number;
  /** Leave the original asset alone: commit to a new one and relink the target. */
  readonly branch?: boolean;
}

export interface RoundTripSession {
  readonly id: string;
  readonly parentDocId: string;
  readonly childDocId: string;
  readonly target: ParentTarget;
  readonly assetId: AssetId;
  /** The head at the moment of opening, so the parent can be rolled back. */
  readonly baseRev: number;
  readonly handles: number;
  readonly handleOffset: number;
  /** The revision this child last sent up, or null before it has sent one. */
  appliedRev: number | null;
  status: "open" | "applied" | "detached";
}

interface RoundTripEvents {
  requested: { parentDocId: string; childDocId: string; target: ParentTarget };
  applied: { parentDocId: string; childDocId: string; assetId: AssetId; rev: number };
  detached: { childDocId: string };
}

export interface RoundTripManagerOptions {
  readonly documents: DocumentStore;
  readonly assets: AssetStore;
  readonly environments: EnvironmentRegistry;
  /**
   * The timeline a parent document undoes through. Applying a child's work is
   * an edit to the parent and has to be undoable there; without a timeline the
   * work still lands, it just cannot be taken back.
   */
  historyFor?(documentId: string): HistoryManager | undefined;
}

/**
 * Opening part of one document in another editor, and taking the result back.
 *
 * The whole mechanism is asset revisions. The parent hands over an asset, the
 * child edits it and commits a revision, and every document holding a reference
 * to that asset is told to take up the new one. Nothing here knows what a
 * raster layer or an audio clip is, and no environment knows another exists —
 * which is what makes a new environment a matter of implementing an interface
 * rather than teaching the others about it.
 */
export class RoundTripManager {
  readonly #sessions = new Map<string, RoundTripSession>();
  readonly #events = new EventBus<RoundTripEvents>();
  readonly #documents: DocumentStore;
  readonly #assets: AssetStore;
  readonly #environments: EnvironmentRegistry;
  readonly #historyFor: (documentId: string) => HistoryManager | undefined;
  readonly #subscription: Disposable;

  constructor(options: RoundTripManagerOptions) {
    this.#documents = options.documents;
    this.#assets = options.assets;
    this.#environments = options.environments;
    this.#historyFor = options.historyFor ?? (() => undefined);

    // The kernel watches revisions and tells the documents that hold the asset.
    // This is the only path between environments.
    this.#subscription = this.#assets.subscribe("revised", ({ assetId, rev, note }) => {
      this.#notifyHolders(assetId, rev, note);
    });
  }

  get sessions(): readonly RoundTripSession[] { return [...this.#sessions.values()]; }

  on<TKey extends keyof RoundTripEvents>(type: TKey, listener: (payload: RoundTripEvents[TKey]) => void): Disposable {
    return this.#events.on(type, listener);
  }

  sessionOf(childDocId: string): RoundTripSession | undefined {
    for (const session of this.#sessions.values()) if (session.childDocId === childDocId) return session;
    return undefined;
  }

  /** Sessions still pointing at a parent, so it can warn before closing. */
  sessionsOfParent(parentDocId: string): readonly RoundTripSession[] {
    return this.sessions.filter((session) => session.parentDocId === parentDocId && session.status !== "detached");
  }

  async open(request: RoundTripRequest): Promise<RoundTripSession> {
    const parent = this.#documents.get(request.parentDocId);
    if (!parent) throw new Error(`Unknown document: ${request.parentDocId}`);

    const parentEnvironment = this.#environments.get(parent.kind);
    // The parent decides what the target is worth as an asset: it may hand back
    // one that already exists, or flatten something new for the occasion.
    const extracted = await parentEnvironment.extractAsset(parent, request.target, {
      handles: request.handles ?? 0,
      forceNew: request.branch ?? false,
    });

    const child = await this.#environments.get(request.targetEnv).createFromAsset(extracted.assetId, { title: extracted.title });
    child.provenance = {
      parentDocId: parent.id,
      parentTarget: request.target,
      sourceAssetId: extracted.assetId,
      writeBack: request.branch ? "new-asset-relink" : "replace-asset",
    };

    const session: RoundTripSession = {
      id: crypto.randomUUID(),
      parentDocId: parent.id,
      childDocId: child.id,
      target: request.target,
      assetId: extracted.assetId,
      baseRev: this.#assets.mustGet(extracted.assetId).head,
      handles: request.handles ?? 0,
      handleOffset: extracted.handleOffset,
      appliedRev: null,
      status: "open",
    };
    this.#sessions.set(session.id, session);
    this.#events.emit("requested", { parentDocId: parent.id, childDocId: child.id, target: request.target });
    return session;
  }

  /** Send the child's work back to the parent. */
  async apply(childDocId: string): Promise<void> {
    const child = this.#documents.get(childDocId);
    if (!child) throw new Error(`Unknown document: ${childDocId}`);
    const session = this.sessionOf(childDocId);
    if (!session) throw new Error(`Document ${childDocId} was not opened from another`);
    if (session.status === "detached") throw new Error("This document is no longer linked to a parent");

    const childEnvironment = this.#environments.get(child.kind);
    const bytes = await childEnvironment.exportAsAsset(child, {
      kind: this.#assets.mustGet(session.assetId).kind,
      lossless: true,
    });
    const note = childEnvironment.describeChanges(child);

    if (child.provenance?.writeBack === "new-asset-relink") {
      const record = this.#assets.mustGet(session.assetId);
      const newAssetId = await this.#assets.importAsset(bytes, { kind: record.kind, mime: record.mime, name: child.name, producedBy: `${child.kind}-env` });
      const parent = this.#documents.get(session.parentDocId);
      if (!parent) throw new Error(`Parent document ${session.parentDocId} is gone`);
      await this.#environments.get(parent.kind).relinkTarget(parent, session.target, newAssetId);
      this.#documents.addAssetRef(parent.id, newAssetId);
      session.status = "applied";
      child.dirty = false;
      this.#events.emit("applied", { parentDocId: parent.id, childDocId, assetId: newAssetId, rev: 0 });
      return;
    }

    const previousRev = this.#assets.mustGet(session.assetId).head;
    const rev = await this.#assets.commitRevision(session.assetId, bytes, `${child.kind}-env`, note);
    session.appliedRev = rev;

    await this.#recordInParentHistory(session, previousRev, rev, note);

    session.status = "applied";
    child.dirty = false;
    this.#events.emit("applied", { parentDocId: session.parentDocId, childDocId, assetId: session.assetId, rev });
  }

  /**
   * Rebuilds sessions for documents restored from a saved session.
   *
   * A child's link to its parent is persisted as its provenance, but the
   * session around it is not. Without rebuilding, a restored child looks
   * ordinary: applying it fails, and it starts following revisions of the very
   * asset it is there to edit, so the parent's undo would reach into it.
   *
   * What cannot be recovered is what the child last sent up — nothing recorded
   * it — so a rebuilt session reports itself in step until the next apply
   * rather than claiming a disagreement it cannot know about.
   */
  adoptRestored(): readonly RoundTripSession[] {
    const rebuilt: RoundTripSession[] = [];
    for (const document of this.#documents.list() as readonly VravioDocument[]) {
      const provenance = document.provenance;
      if (!provenance || this.sessionOf(document.id)) continue;
      const record = this.#assets.get(provenance.sourceAssetId);
      if (!record) continue;
      const session: RoundTripSession = {
        id: crypto.randomUUID(),
        parentDocId: provenance.parentDocId,
        childDocId: document.id,
        target: provenance.parentTarget,
        assetId: provenance.sourceAssetId,
        baseRev: record.head,
        handles: 0,
        handleOffset: 0,
        appliedRev: null,
        status: "open",
      };
      this.#sessions.set(session.id, session);
      rebuilt.push(session);
    }
    return rebuilt;
  }

  /** Cut a child loose; it keeps its content and stops writing back. */
  detach(childDocId: string): void {
    const child = this.#documents.get(childDocId);
    if (child) child.provenance = null;
    const session = this.sessionOf(childDocId);
    if (session) session.status = "detached";
    this.#events.emit("detached", { childDocId });
  }

  dispose(): void { this.#subscription.dispose(); }

  /**
   * Give the parent a way back.
   *
   * Undoing in the parent moves the asset head, which sends the revision the
   * other way through exactly the same notification path — so the parent
   * redraws from the older bytes without any special case for round-trip.
   */
  async #recordInParentHistory(session: RoundTripSession, previousRev: number, rev: number, note: string): Promise<void> {
    const history = this.#historyFor(session.parentDocId);
    if (!history) return;
    const assets = this.#assets, assetId = session.assetId;
    await history.record({
      label: note || "Applied from another environment",
      memoryEstimate: 0,
      storageEstimate: assets.get(assetId)?.revisions.find((revision) => revision.rev === rev)?.bytes ?? 0,
      redo: () => assets.setHead(assetId, rev, "roundtrip"),
      undo: () => assets.setHead(assetId, previousRev, "undo"),
    });
  }

  /**
   * Whether what the parent is showing is still what this child sent up.
   *
   * False once the parent has undone the applied step, or revised the asset by
   * some other route. The child is deliberately left alone in that case, so
   * this is what the shell has to show a tab with: without it the two tabs
   * disagree and nothing on screen says why.
   */
  isOutOfSync(childDocId: string): boolean {
    const session = this.sessionOf(childDocId);
    if (!session || session.appliedRev === null) return false;
    return this.#assets.get(session.assetId)?.head !== session.appliedRev;
  }

  #notifyHolders(assetId: AssetId, rev: number, note: string | undefined): void {
    for (const document of this.#documents.list() as readonly VravioDocument[]) {
      if (!document.assetRefs.has(assetId) || this.#editsAsset(document.id, assetId)) continue;
      this.#environments.find(document.kind)?.onAssetRevised(document, assetId, rev, note);
    }
  }

  /**
   * Whether this document is the one editing that asset rather than showing it.
   *
   * An editor is never dragged by revisions of what it is editing. That covers
   * its own applies — reloading its export would discard everything the flatten
   * left behind — and it covers the parent undoing afterwards: an undo in the
   * composition is a statement about the composition, not an instruction to
   * throw away the work still open in another tab. Detached sessions count too;
   * a document that was the editor does not become a follower by being cut
   * loose.
   */
  #editsAsset(documentId: string, assetId: AssetId): boolean {
    for (const session of this.#sessions.values()) {
      if (session.childDocId === documentId && session.assetId === assetId) return true;
    }
    return false;
  }
}
