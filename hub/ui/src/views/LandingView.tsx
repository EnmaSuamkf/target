import styles from "./LandingView.module.css";

/**
 * The public landing page — what anyone opening the hub sees before signing
 * in. It's the project's storefront: what Target is, what you can do with it,
 * and why it's built the way it is, pitched the way you'd show it to a user or
 * an investor. The only doors forward are Sign in (always) and Get started
 * (only while this machine has never been set up).
 */
export function LandingView({
	setupCompleted,
	onGetStarted,
	onSignIn,
}: {
	setupCompleted: boolean;
	onGetStarted: () => void;
	onSignIn: () => void;
}): React.JSX.Element {
	return (
		<div className={styles.page}>
			<nav className={styles.nav}>
				<div className={styles.brand}>
					<span className={styles.mark} aria-hidden="true">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
							<circle cx="12" cy="12" r="9" />
							<circle cx="12" cy="12" r="4.5" />
							<circle cx="12" cy="12" r="1" fill="currentColor" />
						</svg>
					</span>
					<span className={styles.brandName}>The Target Project</span>
				</div>
				<div className={styles.navActions}>
					<button type="button" className="btn" onClick={onSignIn}>
						Sign in
					</button>
					{!setupCompleted && (
						<button type="button" className="btn btn--primary" onClick={onGetStarted}>
							Get started
						</button>
					)}
				</div>
			</nav>

			<header className={styles.hero}>
				<p className={styles.kicker}>Local-first agent orchestration</p>
				<h1 className={styles.headline}>
					Put your coding agents on rails.
				</h1>
				<p className={styles.tagline}>
					Target turns a goal into a queue of steps and drives one dedicated agent through them — each step
					checked against your acceptance criteria, each run resuming the same conversation, everything stored
					on your machine.
				</p>
				<div className={styles.heroActions}>
					{!setupCompleted && (
						<button type="button" className="btn btn--primary btn--lg" onClick={onGetStarted}>
							Set up this machine →
						</button>
					)}
					<button
						type="button"
						className={`btn ${setupCompleted ? "btn--primary" : ""} btn--lg`}
						onClick={onSignIn}
					>
						Sign in
					</button>
				</div>
				<p className={styles.heroNote}>
					{setupCompleted
						? "This machine already has its account — sign in to reach your workflows."
						: "First time here? Set up takes a minute: one password, one recovery token."}
				</p>
			</header>

			<section className={styles.section} aria-label="Features">
				<h2 className={styles.sectionTitle}>What you can do with Target</h2>
				<div className={styles.grid}>
					<article className={styles.card}>
						<h3>Workflows, not prompts</h3>
						<p>
							Break a goal into ordered steps — "research", "implement", "verify" — and let the engine run them
							one after another while you watch progress live.
						</p>
					</article>
					<article className={styles.card}>
						<h3>One agent per workflow</h3>
						<p>
							Every workflow owns a dedicated agent with a single continuous conversation, so context from step
							one is still there at step twenty.
						</p>
					</article>
					<article className={styles.card}>
						<h3>Built-in quality gates</h3>
						<p>
							Give a step acceptance criteria and the agent judges its own work against them — rejected steps
							retry with feedback. Add a manual review gate where a human should sign off.
						</p>
					</article>
					<article className={styles.card}>
						<h3>Templates</h3>
						<p>
							Save a proven step sequence once — a release checklist, a PR review pass — and stamp it onto any
							new workflow in one click.
						</p>
					</article>
					<article className={styles.card}>
						<h3>Bring your own agent</h3>
						<p>
							Runs on the harness you already use — Claude Code or free-code — on the host or sandboxed in
							Docker. Import an existing conversation as a workflow's starting context.
						</p>
					</article>
					<article className={styles.card}>
						<h3>100% local</h3>
						<p>
							No cloud account, no telemetry, no remote server. Workflows, steps, attachments and your account
							live in one folder on this machine — yours to back up or delete.
						</p>
					</article>
				</div>
			</section>

			<section className={styles.section} aria-label="How it works">
				<h2 className={styles.sectionTitle}>How it works</h2>
				<ol className={styles.steps}>
					<li>
						<span className={styles.stepNum}>1</span>
						<div>
							<h3>Define the path</h3>
							<p>Write the steps, set acceptance criteria and review gates, attach reference images.</p>
						</div>
					</li>
					<li>
						<span className={styles.stepNum}>2</span>
						<div>
							<h3>Agents run it</h3>
							<p>
								The engine dispatches each step to the workflow's agent and verifies the result before moving
								on — stalled runs are detected and retried, not left hanging.
							</p>
						</div>
					</li>
					<li>
						<span className={styles.stepNum}>3</span>
						<div>
							<h3>You stay in control</h3>
							<p>
								Pause, resume, restart, re-run a single step, or open the live conversation in a terminal and
								talk to the agent yourself.
							</p>
						</div>
					</li>
				</ol>
			</section>

			<footer className={styles.footer}>
				<p>The Target Project — agentic workflows that run on your machine, and stay on your machine.</p>
			</footer>
		</div>
	);
}
