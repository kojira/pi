import { gunzipSync } from "node:zlib";

/** Returns the decompressed contents for paths ending in .gz, otherwise the buffer unchanged. */
export function gunzipIfGzPath(filePath: string, buffer: Buffer): Buffer {
	return filePath.endsWith(".gz") ? gunzipSync(buffer) : buffer;
}
