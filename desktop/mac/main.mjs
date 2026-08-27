import { registerTargetShell } from "./shared/main.mjs";

registerTargetShell({
	importMetaUrl: import.meta.url,
	logPrefix: "[target-mac]",
	windowTitle: "Target for Mac",
});
