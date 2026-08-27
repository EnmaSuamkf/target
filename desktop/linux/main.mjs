import { registerTargetShell } from "./shared/main.mjs";

registerTargetShell({
	importMetaUrl: import.meta.url,
	logPrefix: "[target-linux]",
	windowTitle: "Target for Linux",
});
