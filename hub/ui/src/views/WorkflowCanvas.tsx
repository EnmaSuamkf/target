import { useEffect, useMemo, useRef, useState } from "react";
import type { Step } from "../api/types.ts";
import type { CanvasEdge, CanvasNode } from "../lib/canvasLayout.ts";
import { edgePath, focusNodeId, layoutWorkflow } from "../lib/canvasLayout.ts";
import styles from "./WorkflowCanvas.module.css";

/**
 * The workflow as a picture: a card per step, arrows for what runs after what,
 * and a circle on every step that has to satisfy a judge before the run moves
 * on.
 *
 * It exists because the step list can only say "these are the steps, in this
 * order". It cannot show that step 3 is judged and step 4 is not, that a reject
 * loops back rather than forward, or — while a run is in flight — WHERE in the
 * workflow the agent currently is. All three are shapes, and this is where they
 * are drawn.
 *
 * **It is a view, not an editor.** Nothing here mutates anything: there is no
 * dragging, no connecting, no per-node menu. A workflow is changed in the step
 * list and nowhere else, so the only thing a card does when clicked is take the
 * operator to that step's row — one place to look, one place to change.
 *
 * **Live while running.** The canvas renders straight from the same `steps`
 * prop the list does, so the 2s poll animates it for free: the in-flight card
 * pulses, the arrow feeding it flows, and the circle spins while the judge is
 * deciding. The viewport also follows the run — see `focusNodeId` — so a long
 * workflow doesn't leave the operator scrolled to a step that finished ten
 * minutes ago.
 *
 * SVG for the arrows, DOM for the cards, rather than one `<canvas>`: the step
 * descriptions stay real text (selectable, searchable, readable by a screen
 * reader) and the cards stay real buttons, which a bitmap surface would have
 * cost with nothing gained — the drawing is a few dozen boxes and lines, not a
 * scene that needs a raster.
 */

const ZOOM_STEPS = [0.6, 0.75, 0.9, 1, 1.15, 1.35] as const;
const DEFAULT_ZOOM_INDEX = 3;

/**
 * Joins class names, dropping the ones that aren't there. States are looked up
 * dynamically (`styles[`state_${node.state}`]`) and the quiet ones — `pending`
 * on a card, `pending` on a circle — deliberately have no rule of their own:
 * they ARE the base style. Without this, those would each put a literal
 * "undefined" in the class list.
 */
function cls(...names: Array<string | false | undefined>): string {
	return names.filter(Boolean).join(" ");
}

export function WorkflowCanvas({
	steps,
	/** Sends the operator to this step's row in the list, where it can be edited. */
	onOpenStep,
}: {
	steps: Step[];
	onOpenStep: (stepId: string) => void;
}): React.JSX.Element {
	const graph = useMemo(() => layoutWorkflow(steps), [steps]);
	const [zoomIndex, setZoomIndex] = useState(DEFAULT_ZOOM_INDEX);
	const viewportRef = useRef<HTMLDivElement>(null);
	const zoom = ZOOM_STEPS[zoomIndex] ?? 1;

	const focusId = useMemo(() => focusNodeId(graph.nodes), [graph.nodes]);

	// Keep the step being worked on in sight. Keyed on the id alone, never on the
	// graph object, so the 2s poll can't yank the viewport back while the operator
	// is reading somewhere else — it only moves when the run does.
	useEffect(() => {
		if (!focusId) return;
		const viewport = viewportRef.current;
		const node = viewport?.querySelector<HTMLElement>(`[data-canvas-node="${CSS.escape(focusId)}"]`);
		if (!viewport || !node) return;
		const top = node.offsetTop * zoom - viewport.clientHeight / 2 + (node.offsetHeight * zoom) / 2;
		viewport.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
		// `zoom` is deliberately not a dependency: re-scrolling on every zoom press
		// would fight the operator for the viewport.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [focusId]);

	if (graph.nodes.length === 0) {
		return (
			<div className={styles.empty}>
				This workflow has no steps yet — add one below and it appears here.
			</div>
		);
	}

	return (
		<div className={styles.canvas} data-workflow-canvas>
			<div className={styles.toolbar}>
				<p className={styles.hint}>
					A read-only map of this workflow. Click a card to open that step in the list, where it can be edited.
				</p>
				<div className={styles.zoom}>
					<button
						type="button"
						className="btn btn--sm btn--ghost"
						onClick={() => setZoomIndex((i) => Math.max(0, i - 1))}
						disabled={zoomIndex === 0}
						aria-label="Zoom out"
						title="Zoom out"
					>
						<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
							<path d="M5 12h14" />
						</svg>
					</button>
					<span className={styles.zoomLevel}>{Math.round(zoom * 100)}%</span>
					<button
						type="button"
						className="btn btn--sm btn--ghost"
						onClick={() => setZoomIndex((i) => Math.min(ZOOM_STEPS.length - 1, i + 1))}
						disabled={zoomIndex === ZOOM_STEPS.length - 1}
						aria-label="Zoom in"
						title="Zoom in"
					>
						<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
							<path d="M12 5v14M5 12h14" />
						</svg>
					</button>
				</div>
			</div>

			<div className={styles.viewport} ref={viewportRef}>
				<div
					className={styles.stage}
					style={{
						width: graph.width,
						height: graph.height,
						transform: `scale(${zoom})`,
					}}
				>
					<svg
						className={styles.edges}
						width={graph.width}
						height={graph.height}
						viewBox={`0 0 ${graph.width} ${graph.height}`}
						aria-hidden="true"
					>
						<defs>
							{/* One arrowhead per state, because a marker cannot inherit the
							    stroke of the path that uses it. */}
							{(["pending", "active", "done"] as const).map((state) => (
								<marker
									key={state}
									id={`arrow-${state}`}
									viewBox="0 0 10 10"
									refX="9"
									refY="5"
									markerWidth="6"
									markerHeight="6"
									orient="auto-start-reverse"
								>
									<path d="M0 0 L10 5 L0 10 z" className={styles[`head_${state}`]} />
								</marker>
							))}
						</defs>
						{graph.edges.map((edge) => (
							<EdgeLine key={edge.id} edge={edge} />
						))}
					</svg>

					{graph.nodes.map((node) =>
						node.kind === "judge" ? (
							<JudgeCircle key={node.id} node={node} onOpen={onOpenStep} />
						) : (
							<StepCard key={node.id} node={node} onOpen={onOpenStep} />
						),
					)}
				</div>
			</div>

			<ul className={styles.legend}>
				<li>
					<span className={`${styles.swatch} ${styles.swatchRunning}`} aria-hidden="true" /> in flight
				</li>
				<li>
					<span className={`${styles.swatch} ${styles.swatchDone}`} aria-hidden="true" /> done
				</li>
				<li>
					<span className={`${styles.swatch} ${styles.swatchWaiting}`} aria-hidden="true" /> waiting for you
				</li>
				<li>
					<span className={`${styles.swatch} ${styles.swatchFailed}`} aria-hidden="true" /> failed
				</li>
				<li>
					<span className={`${styles.swatch} ${styles.swatchJudge}`} aria-hidden="true" /> judged step
				</li>
			</ul>
		</div>
	);
}

function EdgeLine({ edge }: { edge: CanvasEdge }): React.JSX.Element {
	return (
		<path
			d={edgePath(edge)}
			className={cls(styles.edge, styles[`edge_${edge.state}`], edge.kind === "retry" && styles.edgeRetry)}
			markerEnd={`url(#arrow-${edge.state})`}
			fill="none"
		/>
	);
}

/**
 * One step as a card. A `<button>`, not a `<div>`: it is reachable by keyboard
 * and it announces what pressing it does — which is never "change this step",
 * only "show me this step in the list".
 */
function StepCard({ node, onOpen }: { node: CanvasNode; onOpen: (stepId: string) => void }): React.JSX.Element {
	const isContext = node.kind === "context";
	return (
		<button
			type="button"
			data-canvas-node={node.id}
			className={cls(
				styles.card,
				styles[`state_${node.state}`],
				isContext && styles.cardContext,
				node.selected && styles.cardSelected,
			)}
			style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
			onClick={() => onOpen(node.stepId)}
			title={node.description}
			aria-label={`${isContext ? "Conversation context" : `Step ${node.label}`} — ${node.state}. Opens this step in the list.`}
		>
			<span className={styles.cardHead}>
				<span className={styles.cardIndex}>{node.label}</span>
				{/* The pill takes its colour from the card's own state class (see the
				    `.state_* .cardState` rules), so it never needs one of its own. */}
				<span className={styles.cardState}>
					{isLiveState(node.state) && <span className={styles.dot} aria-hidden="true" />}
					{node.state}
				</span>
			</span>
			<span className={styles.cardBody}>{node.description}</span>
			{!isContext && (node.manualReview || node.inline || node.selected) && (
				<span className={styles.cardFoot}>
					{node.selected && <span className={styles.flag}>selected</span>}
					{node.manualReview && <span className={styles.flag}>manual review</span>}
					{node.inline && <span className={styles.flag}>inline</span>}
				</span>
			)}
		</button>
	);
}

/**
 * The judge, as the circle the step's result has to pass through. Round on
 * purpose: it is the one thing on the canvas that is not a step, and a shape
 * says so before any label is read.
 */
function JudgeCircle({ node, onOpen }: { node: CanvasNode; onOpen: (stepId: string) => void }): React.JSX.Element {
	const label =
		node.state === "judging"
			? "judging this step's result now"
			: node.state === "done"
				? "this step passed its acceptance criteria"
				: node.state === "failed"
					? "this step did not pass its acceptance criteria"
					: "this step will be judged against its acceptance criteria";
	return (
		<button
			type="button"
			data-canvas-node={node.id}
			data-canvas-judge
			className={cls(styles.judge, styles[`judgeState_${node.state}`])}
			style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
			onClick={() => onOpen(node.stepId)}
			title={`Accepts if: ${node.description}`}
			aria-label={`Judge — ${label}. Opens this step in the list.`}
		>
			{/* The ring is a separate element so it can spin while judging without
			    taking the glyph or the retry count with it. */}
			<span className={styles.judgeRing} aria-hidden="true" />
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
				<path d="M12 3v18M5 7h14M6 7l-3 6a3.5 3.5 0 0 0 6 0L6 7zM18 7l-3 6a3.5 3.5 0 0 0 6 0l-3-6z" />
			</svg>
			<span className={styles.judgeLabel}>
				{node.retries ? `${node.retries.count}/${node.retries.max}` : "judge"}
			</span>
		</button>
	);
}

function isLiveState(state: CanvasNode["state"]): boolean {
	return state === "running" || state === "queued" || state === "judging" || state === "waiting";
}
