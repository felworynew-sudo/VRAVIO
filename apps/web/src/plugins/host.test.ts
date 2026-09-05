import { describe, expect, it } from "vitest";
import { runPlugin, type PluginWorkerLike } from "./host";
import { refusalFor } from "./permissions";
import { PLUGIN_API_VERSION, type PluginManifest, type PluginMessage } from "./types";
import samplePlugin, { manifest as sampleManifest } from "./samples/invert.plugin";

/**
 * Stage 10 of docs/migration-plan.md, section 4.7.
 *
 * The permission checks are the substance here: a permission that is only
 * documented is not a permission. Each is checked by watching what actually
 * crosses the wire, not by asking the host what it thinks it did.
 */

const manifest = (permissions: PluginManifest["permissions"], overrides: Partial<PluginManifest> = {}): PluginManifest => ({
  id: "test.plugin", apiVersion: PLUGIN_API_VERSION, label: { en: "Test" }, environment: "raster", permissions, entry: "./test", ...overrides,
});

const W = 4, H = 4;
const picture = () => {
  const pixels = new Uint8ClampedArray(W * H * 4);
  for (let index = 0; index < pixels.length; index += 4) { pixels[index] = 10; pixels[index + 1] = 20; pixels[index + 2] = 30; pixels[index + 3] = 255; }
  return pixels;
};

/**
 * A stand-in worker that records what it was sent and replies with whatever
 * the test wants. Running the real `Worker` here would test the browser, not
 * the host; what is under test is which messages the host sends and which
 * answers it believes.
 */
function fakeWorker(reply: (sent: Record<string, unknown>) => PluginMessage | null) {
  const sentMessages: Record<string, unknown>[] = [];
  let terminated = false;
  const worker: PluginWorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage: (message) => {
      sentMessages.push(message as Record<string, unknown>);
      const answer = reply(message as Record<string, unknown>);
      if (answer) queueMicrotask(() => worker.onmessage?.({ data: answer }));
    },
    terminate: () => { terminated = true; },
  };
  return { worker, sentMessages, wasTerminated: () => terminated };
}

const echoBack = (sent: Record<string, unknown>): PluginMessage =>
  ({ type: "result", requestId: 1, pixels: (sent.pixels as ArrayBuffer | undefined) ?? new Uint8ClampedArray(W * H * 4).buffer, width: W, height: H });

describe("what a plugin is allowed to receive", () => {
  it("sends the picture to a plugin that asked to read the document", async () => {
    const { worker, sentMessages } = fakeWorker(echoBack);

    await runPlugin(manifest(["read-document", "write-pixels"]), { pixels: picture(), width: W, height: H }, () => worker);

    expect(sentMessages[0]?.pixels, "a plugin with read-document got no pixels").toBeInstanceOf(ArrayBuffer);
  });

  it("sends no picture at all to a plugin that did not ask for it", async () => {
    // The half of the permission that protects anything: pixels a plugin never
    // receives are pixels it cannot send anywhere.
    const { worker, sentMessages } = fakeWorker(echoBack);

    await runPlugin(manifest(["write-pixels"]), { pixels: picture(), width: W, height: H }, () => worker);

    expect(sentMessages[0]?.pixels).toBeUndefined();
  });
});

describe("what a plugin is allowed to change", () => {
  it("returns the pixels a plugin with write-pixels produced", async () => {
    const changed = new Uint8ClampedArray(W * H * 4).fill(7);
    const { worker } = fakeWorker(() => ({ type: "result", requestId: 1, pixels: changed.buffer, width: W, height: H }));

    const outcome = await runPlugin(manifest(["read-document", "write-pixels"]), { pixels: picture(), width: W, height: H }, () => worker);

    expect(outcome.error).toBeNull();
    expect(outcome.pixels?.[0]).toBe(7);
  });

  it("ignores pixels from a plugin without write-pixels, however insistent", async () => {
    // The plugin is not asked to behave; whatever it sends simply does not
    // become an edit.
    const changed = new Uint8ClampedArray(W * H * 4).fill(7);
    const { worker } = fakeWorker(() => ({ type: "result", requestId: 1, pixels: changed.buffer, width: W, height: H }));

    const outcome = await runPlugin(manifest(["read-document"]), { pixels: picture(), width: W, height: H }, () => worker);

    expect(outcome.pixels, "an unpermitted plugin's pixels reached the caller").toBeNull();
    expect(outcome.error).toBeNull();
  });

  it("refuses a buffer of the wrong size rather than writing it", async () => {
    // Written into the layer it would be garbage, or would throw somewhere far
    // from the plugin that caused it.
    const { worker } = fakeWorker(() => ({ type: "result", requestId: 1, pixels: new Uint8ClampedArray(8).buffer, width: W, height: H }));

    const outcome = await runPlugin(manifest(["read-document", "write-pixels"]), { pixels: picture(), width: W, height: H }, () => worker);

    expect(outcome.pixels).toBeNull();
    expect(outcome.error).toContain("expected");
  });
});

describe("refusing to load at all", () => {
  it("turns away a plugin built for another API version, before spawning it", async () => {
    let spawned = false;
    const outcome = await runPlugin(manifest(["read-document"], { apiVersion: PLUGIN_API_VERSION + 1 }), { pixels: picture(), width: W, height: H }, () => { spawned = true; return fakeWorker(echoBack).worker; });

    expect(outcome.error).toContain("plugin API");
    // A worker that has started is a worker that has already run the plugin's
    // top-level code, so the refusal has to come first.
    expect(spawned, "a refused plugin was spawned anyway").toBe(false);
  });

  it("turns away a permission this build does not know", () => {
    expect(refusalFor(manifest(["read-document", "teleport" as never]))?.reason).toBe("unknown-permission");
  });

  it("accepts a manifest it should", () => {
    // Guards the three refusals above against passing because everything is
    // refused.
    expect(refusalFor(manifest(["read-document", "write-pixels"]))).toBeNull();
  });
});

describe("a plugin that misbehaves", () => {
  it("reports what it threw, naming the failure rather than swallowing it", async () => {
    const { worker } = fakeWorker(() => ({ type: "error", requestId: 1, message: "plugin exploded" }));

    expect((await runPlugin(manifest(["read-document", "write-pixels"]), { pixels: picture(), width: W, height: H }, () => worker)).error).toBe("plugin exploded");
  });

  it("terminates the worker whatever happened", async () => {
    // A plugin that left a timer running, or wedged itself, must not outlive
    // the run that started it.
    const failing = fakeWorker(() => ({ type: "error", requestId: 1, message: "no" }));
    await runPlugin(manifest(["read-document"]), { pixels: picture(), width: W, height: H }, () => failing.worker);

    expect(failing.wasTerminated()).toBe(true);
  });
});

describe("the sample plugin", () => {
  it("inverts colour and leaves alpha alone", async () => {
    // Run directly, as the worker would: the sample is documentation only if
    // it is the same code that actually works.
    const result = await samplePlugin.run({ pixels: picture(), width: W, height: H, options: {} });

    expect(result?.[0]).toBe(245);
    expect(result?.[1]).toBe(235);
    expect(result?.[2]).toBe(225);
    // Inverting alpha would turn transparent pixels opaque and paint a black
    // rectangle where there had been nothing.
    expect(result?.[3]).toBe(255);
  });

  it("carries a manifest this host would accept", () => {
    expect(refusalFor(sampleManifest as unknown as PluginManifest)).toBeNull();
  });

  it("does nothing when it was sent no pixels", async () => {
    // What a plugin without `read-document` sees. It must not throw.
    expect(await samplePlugin.run({ pixels: null, width: W, height: H, options: {} })).toBeNull();
  });
});
