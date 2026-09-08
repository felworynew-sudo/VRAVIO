import { describe, expect, it } from "vitest";
import { runPlugin, type PluginWorkerLike } from "./host";
import { refusalFor } from "./permissions";
import { PLUGIN_API_VERSION, type PluginManifest, type PluginMessage, type PluginPayload } from "./types";
import samplePlugin, { manifest as sampleManifest } from "./samples/invert.plugin";
import gainPlugin, { manifest as gainManifest } from "./samples/gain.plugin";

/**
 * Stage 10 of docs/migration-plan.md, section 4.7.
 *
 * The permission checks are the substance here: a permission that is only
 * documented is not a permission. Each is checked by watching what actually
 * crosses the wire, not by asking the host what it thinks it did.
 *
 * Everything in this file is deliberately environment-blind, because the host
 * is: the payloads below could be pixels, samples or anything else, and not one
 * assertion would change.
 */

const manifest = (permissions: PluginManifest["permissions"], overrides: Partial<PluginManifest> = {}): PluginManifest => ({
  id: "test.plugin", apiVersion: PLUGIN_API_VERSION, label: { en: "Test" }, environment: "raster", permissions, entry: "./test", ...overrides,
});

const W = 4, H = 4;
const picture = (): PluginPayload => {
  const pixels = new Uint8ClampedArray(W * H * 4);
  for (let index = 0; index < pixels.length; index += 4) { pixels[index] = 10; pixels[index + 1] = 20; pixels[index + 2] = 30; pixels[index + 3] = 255; }
  return { kind: "pixels", buffer: pixels.buffer as ArrayBuffer, meta: { width: W, height: H } };
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

const payloadOf = (sent: Record<string, unknown>): PluginPayload | undefined => sent.payload as PluginPayload | undefined;

const echoBack = (sent: Record<string, unknown>): PluginMessage =>
  ({ type: "result", requestId: 1, payload: payloadOf(sent) ?? { kind: "pixels", buffer: new Uint8ClampedArray(W * H * 4).buffer as ArrayBuffer, meta: { width: W, height: H } } });

describe("what a plugin is allowed to receive", () => {
  it("sends the document to a plugin that asked to read it", async () => {
    const { worker, sentMessages } = fakeWorker(echoBack);

    await runPlugin(manifest(["read-document", "write-document"]), { payload: picture() }, () => worker);

    expect(payloadOf(sentMessages[0]!)?.buffer, "a plugin with read-document got no payload").toBeInstanceOf(ArrayBuffer);
  });

  it("sends nothing at all to a plugin that did not ask for it", async () => {
    // The half of the permission that protects anything: a document a plugin
    // never receives is one it cannot send anywhere.
    const { worker, sentMessages } = fakeWorker(echoBack);

    await runPlugin(manifest(["write-document"]), { payload: picture() }, () => worker);

    expect(sentMessages[0]?.payload).toBeUndefined();
  });

  it("does not hand over the caller's own buffer, which transferring would detach", async () => {
    const { worker, sentMessages } = fakeWorker(echoBack);
    const original = picture();

    await runPlugin(manifest(["read-document"]), { payload: original }, () => worker);

    expect(payloadOf(sentMessages[0]!)?.buffer).not.toBe(original.buffer);
    expect(original.buffer?.byteLength, "the caller's buffer was detached by the transfer").toBe(W * H * 4);
  });
});

describe("what a plugin is allowed to change", () => {
  it("returns what a plugin with write-document produced", async () => {
    const changed = new Uint8ClampedArray(W * H * 4).fill(7);
    const { worker } = fakeWorker(() => ({ type: "result", requestId: 1, payload: { kind: "pixels", buffer: changed.buffer as ArrayBuffer, meta: { width: W, height: H } } }));

    const outcome = await runPlugin(manifest(["read-document", "write-document"]), { payload: picture() }, () => worker);

    expect(outcome.error).toBeNull();
    expect(new Uint8ClampedArray(outcome.payload!.buffer!)[0]).toBe(7);
  });

  it("ignores what a plugin without write-document returned, however insistent", async () => {
    // The plugin is not asked to behave; whatever it sends simply does not
    // become an edit.
    const changed = new Uint8ClampedArray(W * H * 4).fill(7);
    const { worker } = fakeWorker(() => ({ type: "result", requestId: 1, payload: { kind: "pixels", buffer: changed.buffer as ArrayBuffer, meta: { width: W, height: H } } }));

    const outcome = await runPlugin(manifest(["read-document"]), { payload: picture() }, () => worker);

    expect(outcome.payload, "an unpermitted plugin's payload reached the caller").toBeNull();
    expect(outcome.error).toBeNull();
  });
});

describe("refusing to load at all", () => {
  it("turns away a plugin built for another API version, before spawning it", async () => {
    let spawned = false;
    const outcome = await runPlugin(manifest(["read-document"], { apiVersion: PLUGIN_API_VERSION + 1 }), { payload: picture() }, () => { spawned = true; return fakeWorker(echoBack).worker; });

    expect(outcome.error).toContain("plugin API");
    // A worker that has started is a worker that has already run the plugin's
    // top-level code, so the refusal has to come first.
    expect(spawned, "a refused plugin was spawned anyway").toBe(false);
  });

  it("turns away a permission this build does not know", () => {
    expect(refusalFor(manifest(["read-document", "teleport" as never]))?.reason).toBe("unknown-permission");
  });

  it("turns away a plugin for an environment this build cannot host, before spawning it", async () => {
    // The point of the whole rework: an environment with no plugin surface has
    // no way to read a document into a payload or write one back, so there is
    // nothing to run and nothing safe to do with what came back.
    let spawned = false;
    const outcome = await runPlugin(
      manifest(["read-document"], { environment: "video" }),
      { payload: picture(), hostableEnvironments: ["raster", "audio"] },
      () => { spawned = true; return fakeWorker(echoBack).worker; },
    );

    expect(outcome.error).toContain("video");
    expect(spawned, "a plugin for an unhostable environment was spawned anyway").toBe(false);
  });

  it("turns away a manifest that names no environment at all", () => {
    expect(refusalFor(manifest(["read-document"], { environment: "" }))?.reason).toBe("malformed");
  });

  it("accepts a manifest it should", () => {
    // Guards the refusals above against passing because everything is refused.
    expect(refusalFor(manifest(["read-document", "write-document"]))).toBeNull();
    expect(refusalFor(manifest(["read-document"]), ["raster", "audio"])).toBeNull();
  });
});

describe("a plugin that misbehaves", () => {
  it("reports what it threw, naming the failure rather than swallowing it", async () => {
    const { worker } = fakeWorker(() => ({ type: "error", requestId: 1, message: "plugin exploded" }));

    expect((await runPlugin(manifest(["read-document", "write-document"]), { payload: picture() }, () => worker)).error).toBe("plugin exploded");
  });

  it("terminates the worker whatever happened", async () => {
    // A plugin that left a timer running, or wedged itself, must not outlive
    // the run that started it.
    const failing = fakeWorker(() => ({ type: "error", requestId: 1, message: "no" }));
    await runPlugin(manifest(["read-document"]), { payload: picture() }, () => failing.worker);

    expect(failing.wasTerminated()).toBe(true);
  });
});

describe("the raster sample plugin", () => {
  it("inverts colour and leaves alpha alone", async () => {
    // Run directly, as the worker would: the sample is documentation only if
    // it is the same code that actually works.
    const result = await samplePlugin.run({ payload: picture(), options: {} });
    const pixels = new Uint8ClampedArray(result!.buffer!);

    expect(pixels[0]).toBe(245);
    expect(pixels[1]).toBe(235);
    expect(pixels[2]).toBe(225);
    // Inverting alpha would turn transparent pixels opaque and paint a black
    // rectangle where there had been nothing.
    expect(pixels[3]).toBe(255);
  });

  it("carries a manifest this host would accept", () => {
    expect(refusalFor(sampleManifest as unknown as PluginManifest, ["raster", "audio"])).toBeNull();
  });

  it("does nothing when it was sent nothing", async () => {
    // What a plugin without `read-document` sees. It must not throw.
    expect(await samplePlugin.run({ payload: null, options: {} })).toBeNull();
  });

  it("does nothing with a payload of a kind it does not understand", async () => {
    // A plugin is only ever offered inside the environment its manifest names,
    // but one that reads a buffer without checking corrupts something the first
    // time that stops being true.
    const samples = { kind: "samples", buffer: new Float32Array(8).buffer as ArrayBuffer, meta: { channels: 1 } };
    expect(await samplePlugin.run({ payload: samples, options: {} })).toBeNull();
  });
});

describe("the audio sample plugin", () => {
  const tone = (): PluginPayload => ({ kind: "samples", buffer: Float32Array.from([1, -1, 0.5, -0.5]).buffer as ArrayBuffer, meta: { sampleRate: 48000, channels: 1, frames: 4 } });

  it("halves amplitude and keeps the payload's own description of itself", async () => {
    const result = await gainPlugin.run({ payload: tone(), options: {} });
    const samples = new Float32Array(result!.buffer!);

    expect([...samples]).toEqual([0.5, -0.5, 0.25, -0.25]);
    expect(result!.meta.sampleRate).toBe(48000);
  });

  it("clamps rather than handing back samples that would clip", async () => {
    const result = await gainPlugin.run({ payload: tone(), options: { gain: 4 } });
    const samples = new Float32Array(result!.buffer!);

    expect(Math.max(...samples)).toBeLessThanOrEqual(1);
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(-1);
  });

  it("carries a manifest this host would accept, for a different environment", () => {
    expect(refusalFor(gainManifest as unknown as PluginManifest, ["raster", "audio"])).toBeNull();
    expect(gainManifest.environment).toBe("audio");
  });

  it("does nothing with a payload of a kind it does not understand", async () => {
    expect(await gainPlugin.run({ payload: picture(), options: {} })).toBeNull();
  });
});
