import { useCallback, useRef, useState } from "react";
import { Modal } from "./Modal.tsx";

/**
 * Promise-based confirmation built on `Modal`, replacing the browser `confirm()`
 * and the bespoke backdrop the previous UI carried. Call `confirm({...})` and
 * await a boolean:
 *
 * ```ts
 * if (await confirm({ title: "Delete workflow", danger: true })) { ... }
 * ```
 *
 * The resolver is parked in a ref while the dialog is open, so the caller reads
 * as a plain sequential action rather than a pair of callbacks.
 */

export interface ConfirmOptions {
	title: string;
	description?: string;
	body?: React.ReactNode;
	confirmLabel?: string;
	cancelLabel?: string;
	danger?: boolean;
}

export function useConfirm(): {
	confirm: (options: ConfirmOptions) => Promise<boolean>;
	dialog: React.JSX.Element | null;
} {
	const [options, setOptions] = useState<ConfirmOptions | null>(null);
	const resolveRef = useRef<((value: boolean) => void) | null>(null);

	const confirm = useCallback((next: ConfirmOptions): Promise<boolean> => {
		setOptions(next);
		return new Promise<boolean>((resolve) => {
			resolveRef.current = resolve;
		});
	}, []);

	const settle = useCallback((value: boolean) => {
		resolveRef.current?.(value);
		resolveRef.current = null;
		setOptions(null);
	}, []);

	const dialog = options ? (
		<Modal
			open
			size="sm"
			title={options.title}
			{...(options.description ? { description: options.description } : {})}
			onClose={() => settle(false)}
			footer={
				<>
					<button type="button" className="btn" onClick={() => settle(false)}>
						{options.cancelLabel ?? "Cancel"}
					</button>
					<button
						type="button"
						className={options.danger ? "btn btn--danger" : "btn btn--primary"}
						onClick={() => settle(true)}
					>
						{options.confirmLabel ?? "Confirm"}
					</button>
				</>
			}
		>
			{options.body}
		</Modal>
	) : null;

	return { confirm, dialog };
}
