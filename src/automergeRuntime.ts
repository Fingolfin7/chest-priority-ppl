// Browser builds alias "@automerge/automerge" here (see vite.config.ts). The WASM
// ships as its own hashed file, compiled while it streams and precached by the
// service worker, instead of a ~4.8 MB base64 string parsed with the main bundle.
// Node tests import the package directly and never load this module.
import { initializeWasm } from "@automerge/automerge/slim";
import wasmUrl from "@automerge/automerge/automerge.wasm?url";

export * from "@automerge/automerge/slim";

await initializeWasm(wasmUrl);
