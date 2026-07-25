import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import styles from "./Toast.module.css";

/**
 * Non-blocking feedback, replacing the `alert()` calls the previous UI used for
 * every failure. `alert()` blocks the event loop, which on a page that polls
 * every 2s means the queue keeps filling behind the dialog.
 *
 * Errors stay until dismissed (a failed action is worth reading); successes
 * auto-dismiss. The region is an `aria-live` polite log so screen readers
 * announce it without stealing focus.
 */

type ToastKind = "success" | "error" | "info";

interface Toast {
	id: number;
	kind: ToastKind;
	message: string;
}

interface ToastApi {
	success: (message: string) => void;
	error: (message: string) => void;
	info: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
	const ctx = useContext(ToastContext);
	if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
	return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
	const [toasts, setToasts] = useState<Toast[]>([]);
	const nextId = useRef(1);

	const dismiss = useCallback((id: number) => {
		setToasts((current) => current.filter((t) => t.id !== id));
	}, []);

	const push = useCallback(
		(kind: ToastKind, message: string) => {
			const id = nextId.current++;
			setToasts((current) => [...current, { id, kind, message }]);
			// Errors persist until dismissed; transient kinds clear themselves.
			if (kind !== "error") setTimeout(() => dismiss(id), 4000);
		},
		[dismiss],
	);

	const api = useMemo<ToastApi>(
		() => ({
			success: (message) => push("success", message),
			error: (message) => push("error", message),
			info: (message) => push("info", message),
		}),
		[push],
	);

	return (
		<ToastContext.Provider value={api}>
			{children}
			<div className={styles.region} role="log" aria-live="polite" aria-relevant="additions">
				{toasts.map((toast) => (
					<div key={toast.id} className={`${styles.toast} ${styles[toast.kind]}`}>
						<span className={styles.icon} aria-hidden="true">
							{toast.kind === "success" ? "✓" : toast.kind === "error" ? "!" : "i"}
						</span>
						<span className={styles.message}>{toast.message}</span>
						<button
							type="button"
							className={styles.close}
							onClick={() => dismiss(toast.id)}
							aria-label="Dismiss notification"
						>
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
								<path d="M18 6 6 18M6 6l12 12" />
							</svg>
						</button>
					</div>
				))}
			</div>
		</ToastContext.Provider>
	);
}
