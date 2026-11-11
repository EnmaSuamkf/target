import { useEffect, useState } from "react";
import { listPipelines } from "../api/client.ts";
import type { PipelineSummary } from "../api/types.ts";
import styles from "./CommandStepFields.module.css";

/**
 * The pipeline picker and one field per input the pipeline declares. Shared by the
 * add-step form and the step editor so a command step is described the same way
 * wherever it is written.
 *
 * `onReady` reports whether the step can be saved: a pipeline is chosen and every
 * required input has a value. A required input that is still empty keeps Add
 * step disabled, rather than failing on the server after the operator pressed it.
 */
export function CommandStepFields({
	pipelineId,
	onPipelineId,
	inputs,
	onInputs,
	onReady,
	disabled,
}: {
	pipelineId: string;
	onPipelineId: (id: string) => void;
	inputs: Record<string, string>;
	onInputs: (inputs: Record<string, string>) => void;
	onReady: (ready: boolean) => void;
	disabled: boolean;
}): React.JSX.Element {
	const [pipelines, setPipelines] = useState<PipelineSummary[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;
		listPipelines()
			.then((list) => {
				if (alive) setPipelines(list);
			})
			.catch((err: unknown) => {
				if (alive) setLoadError(err instanceof Error ? err.message : String(err));
			});
		return () => {
			alive = false;
		};
	}, []);

	const chosen = pipelines?.find((p) => p.id === pipelineId) ?? null;
	const declared = chosen ? Object.entries(chosen.inputs) : [];
	const missingRequired = declared.some(([name, decl]) => decl.required && (inputs[name] ?? "").trim() === "");
	const ready = chosen !== null && !missingRequired;

	useEffect(() => {
		onReady(ready);
		// `onReady` is a state setter from the parent; it is stable.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ready]);

	return (
		<div className={styles.fields}>
			<div className="field">
				<label className="label" htmlFor="command-pipeline">
					Pipeline
				</label>
				<select
					id="command-pipeline"
					className="input"
					value={pipelineId}
					onChange={(ev) => onPipelineId(ev.target.value)}
					disabled={disabled || pipelines === null}
				>
					<option value="">{pipelines === null ? "Loading pipelines…" : "Choose a pipeline"}</option>
					{(pipelines ?? []).map((p) => (
						<option key={p.id} value={p.id}>
							{p.name}
							{p.trusted ? "" : " — needs approval"}
						</option>
					))}
				</select>
				{loadError && <p className={styles.error}>{loadError}</p>}
				{pipelines !== null && pipelines.length === 0 && (
					<p className="hint">No pipelines yet. Create one in Catalog → Pipelines first.</p>
				)}
				{chosen && !chosen.trusted && (
					<p className={styles.warn}>
						This pipeline needs approval. The step will fail with "pipeline not trusted" until an operator approves it.
					</p>
				)}
			</div>

			{declared.map(([name, decl]) => (
				<div className="field" key={name}>
					<label className="label" htmlFor={`command-input-${name}`}>
						{name}
						{decl.required ? <span className={styles.required}> *</span> : null}
					</label>
					<input
						id={`command-input-${name}`}
						className="input"
						value={inputs[name] ?? ""}
						placeholder={decl.default ?? ""}
						onChange={(ev) => onInputs({ ...inputs, [name]: ev.target.value })}
						disabled={disabled}
						autoComplete="off"
						spellCheck={false}
					/>
					{decl.description && <p className="hint">{decl.description}</p>}
					{decl.default !== null && decl.default !== "" && !decl.required && (
						<p className="hint">Empty uses the default: {decl.default}</p>
					)}
				</div>
			))}
		</div>
	);
}
