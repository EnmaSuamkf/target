import { registerTargetShell } from "./shared/main.mjs";

registerTargetShell({
	importMetaUrl: import.meta.url,
	logPrefix: "[target-windows]",
	windowTitle: "Target for Windows",
});
