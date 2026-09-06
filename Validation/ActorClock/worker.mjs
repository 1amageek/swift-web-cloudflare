import wasmModule from "./app.wasm";
import { SwiftRuntime } from "./runtime.mjs";
import { WASI, File, OpenFile, ConsoleStdout } from "@bjorn3/browser_wasi_shim";

export default {
  async fetch(request) {
    const stats = { active: 0, fired: 0, aborted: 0, cancelledLong: 0, firedLong: 0 };
    const nativeWait = scheduler.wait.bind(scheduler);
    const originalWait = scheduler.wait;
    scheduler.wait = (delay, options) => {
      stats.active++;
      return nativeWait(delay, options).then(
        () => { stats.active--; stats.fired++; if (delay >= 500) stats.firedLong++; },
        error => {
          stats.active--; stats.aborted++;
          if (delay >= 500) stats.cancelledLong++;
          throw error;
        }
      );
    };
    try {
      const wasi = new WASI([], [], [
        new OpenFile(new File([])),
        ConsoleStdout.lineBuffered(console.log),
        ConsoleStdout.lineBuffered(console.error),
      ]);
      const swift = new SwiftRuntime();
      const instance = await WebAssembly.instantiate(wasmModule, {
        wasi_snapshot_preview1: wasi.wasiImport,
        javascript_kit: swift.wasmImports,
      });
      swift.setInstance(instance);
      wasi.initialize({ exports: {
        memory: instance.exports.memory,
        _initialize: instance.exports._initialize,
      }});
      const completion = new Promise(resolve => { globalThis.clockValidationDone = resolve; });
      instance.exports.validate_clock(new URL(request.url).pathname === "/unavailable" ? 1 : 0);
      const result = await completion;
      const atCompletion = { ...stats };
      await nativeWait(600);
      return Response.json({ result, atCompletion, afterGrace: stats });
    } finally {
      scheduler.wait = originalWait;
      delete globalThis.clockValidationDone;
    }
  },
};
