import fsPromises from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname } from "node:path";

const markerPath = process.env.PROSE_TEST_PRESSURE_LATEST_MARKER;
const dispatchMarkerPath = process.env.PROSE_TEST_PRESSURE_DISPATCH_MARKER;

if (markerPath !== undefined && markerPath.length > 0) {
	const originalWriteFile = fsPromises.writeFile;
	let blocked = false;

	fsPromises.writeFile = async function patchedWriteFile(path, data, options) {
		const result = await originalWriteFile.call(this, path, data, options);
		const pathText = String(path);
		if (!blocked && pathText.endsWith("/pressure.latest.json")) {
			blocked = true;
			mkdirSync(dirname(markerPath), { recursive: true });
			writeFileSync(
				markerPath,
				`${JSON.stringify({
					pid: process.pid,
					path: pathText,
					writtenAt: new Date().toISOString(),
				})}\n`,
			);
			await new Promise(() => {});
		}
		return result;
	};

	syncBuiltinESMExports();
}

if (dispatchMarkerPath !== undefined && dispatchMarkerPath.length > 0) {
	const originalOpen = fsPromises.open;
	let blocked = false;

	fsPromises.open = async function patchedOpen(path, flags, mode) {
		const file = await originalOpen.call(this, path, flags, mode);
		const pathText = String(path);
		if (!blocked && pathText.includes("/pressure.dispatches/") && pathText.endsWith(".json")) {
			const originalWriteFile = file.writeFile.bind(file);
			file.writeFile = async function patchedFileWriteFile(data, options) {
				const result = await originalWriteFile(data, options);
				if (!blocked) {
					blocked = true;
					mkdirSync(dirname(dispatchMarkerPath), { recursive: true });
					writeFileSync(
						dispatchMarkerPath,
						`${JSON.stringify({
							pid: process.pid,
							path: pathText,
							writtenAt: new Date().toISOString(),
						})}\n`,
					);
					await new Promise(() => {});
				}
				return result;
			};
		}
		return file;
	};

	syncBuiltinESMExports();
}
