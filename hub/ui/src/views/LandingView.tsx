import styles from "./LandingView.module.css";

/**
 * The public landing page — what anyone opening the hub sees before signing
 * in. It's the project's storefront, and it argues one idea rather than listing
 * features: **Workflow Driven Development**. The unit of work is not the
 * prompt, it's the workflow — ordered steps, an acceptance criterion on each,
 * one agent running them autonomously (in Docker if you want), and numbers at
 * the end. Everything on the page is a consequence of that claim.
 *
 * The only doors forward are Sign in (always) and Get started (only while this
 * machine has never been set up).
 */

/** The four pillars, in the order the argument needs them: determinism, judgement, autonomy, measurement. */
const PILLARS = [
	{
		title: "Deterministic by construction",
		body: "A workflow is an explicit, ordered list of steps you can read, reorder, re-run and save as a template. The same workflow takes the same path every time — the agent chooses how to do a step, never which step comes next.",
	},
	{
		title: "A judge on every step",
		body: "Give a step an acceptance criterion and it is graded against it before the workflow may advance. A rejected step retries with the judge's reason attached, so the second attempt fixes the actual gap instead of rolling the dice again.",
	},
	{
		title: "Human gates where they matter",
		body: "Mark the steps a person must sign off — a migration, a deploy, a public PR. The run stops there and waits for you, and only there. Everything else keeps moving without you.",
	},
	{
		title: "Autonomous, sandboxed runs",
		body: "Start a workflow and walk away. Steps run unattended on your harness of choice, on the host or isolated in a Docker container, with a watchdog that tells a hung agent apart from one that's simply thinking.",
	},
	{
		title: "Metrics on every run",
		body: "Live progress, per-step timings, pass/fail history, token and context usage, and the reason a step stalled — kept per step, so \"is this actually making us faster?\" is a question with an answer.",
	},
	{
		title: "Local-first, no cloud",
		body: "No account, no telemetry, no remote server. Workflows, steps, results and attachments live in one folder on this machine — yours to back up, inspect or delete.",
	},
] as const;

/** The four beats of a run, matching the engine's real lifecycle. */
const HOW = [
	{
		title: "Shape the workflow",
		body: "Break the goal into steps and write what each one has to achieve. Attach references, mark the steps a human must approve, or stamp the whole thing from a saved template.",
	},
	{
		title: "Set the bar per step",
		body: "Add the acceptance criterion the step will be graded on. It's given to the agent up front — so it aims at the target — and to the judge afterwards.",
	},
	{
		title: "Let it run",
		body: "One dedicated agent takes the steps in order on a single continuous conversation, on your machine or inside Docker, while you do something else.",
	},
	{
		title: "Read the result",
		body: "Every step lands with a verdict, a duration and a written result. Re-run one step, resume the run, or open the live conversation and talk to the agent yourself.",
	},
] as const;

/** The mock workflow in the hero: what the product looks like mid-run, without a screenshot to keep in sync. */
const MOCK_STEPS = [
	{ label: "Research the payments API", state: "passed" as const },
	{ label: "Implement the webhook handler", state: "passed" as const },
	{ label: "Write tests · judge running", state: "running" as const },
	{ label: "Open the pull request", state: "queued" as const },
];

/** The two claims that close the hero: where a run happens, and how it stays predictable. */
const HERO_CARDS = [
	{
		title: "Every run, sandboxed in Docker",
		body: "Point a workflow at a container and the whole run happens inside it — your harness, your repo, none of your machine. Prefer the host? Flip it back. The workflow is identical either way.",
		icon: "M4 8h16v11H4z M8 8V5h8v3 M4 12.5h16",
	},
	{
		title: "A deterministic agent orchestrator",
		body: "The workflow fixes the route: ordered steps, one agent carrying the whole conversation, a judge at every gate. The agent decides how to do a step — never which step comes next — so the same workflow takes the same path every time.",
		icon: "M3 19h4v-4h4v-4h4V7h4",
	},
] as const;

/** The six things you actually touch in the hub, in the order you meet them. */
const FEATURES = [
	{
		title: "Templates",
		body: "A named, tagged library of step lists you can search and edit, where every step keeps its acceptance criterion, retry budget and review gate. Templates never execute themselves — they seed the workflows that do.",
	},
	{
		title: "Start from a template, not a blank page",
		body: "Stamp a whole workflow out of a template in one click, or append one to a workflow you already have — including a run that is already in flight.",
	},
	{
		title: "Clone a workflow",
		body: "A run worth repeating is one click from a second one. Cloning opens the create form already seeded with the original's steps, so you change the one thing that differs and leave the rest alone.",
	},
	{
		title: "Canvas view",
		body: "The workflow as a picture: a card per step, arrows for what runs after what, a mark on every step a judge has to clear, and — while a run is in flight — where the agent is right now.",
	},
	{
		title: "Request human intervention",
		body: "A toggle on any step. Turn it on and the run stops there and waits for you to read the result and approve it; everything else keeps moving unattended. Turn it off and nothing ever blocks.",
	},
	{
		title: "Run only the steps you tick",
		body: "Every step has a checkbox, and Start runs exactly what's ticked — one retry, the last three steps, or the whole list. The selection syncs the moment you change it, mid-run included.",
	},
] as const;

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
				<div className={styles.navLinks}>
					<a href="#method">The method</a>
					<a href="#pillars">How it holds up</a>
					<a href="#features">Features</a>
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
				<div className={styles.heroInner}>
					<div className={styles.heroCopy}>
						<p className={styles.kicker}>Workflow Driven Development</p>
						<h1 className={styles.headline}>Your next feature is a workflow, not a prompt.</h1>
						<p className={styles.tagline}>
							WDD is a simple discipline: stop handing an agent one big prompt and hoping. Break the goal into
							ordered steps, put an acceptance criterion on each one, and let a dedicated agent run the whole
							thing — autonomously, sandboxed in Docker, judged at every step, measured end to end.
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
								: "First time here? Setup takes a minute: one password, one recovery token. Nothing leaves the machine."}
						</p>
					</div>

					<div className={styles.mock} aria-hidden="true">
						<div className={styles.mockBar}>
							<span className={styles.mockName}>add-payment-webhook</span>
							<span className={styles.mockBadge}>running in docker</span>
						</div>
						<ol className={styles.mockSteps}>
							{MOCK_STEPS.map((step, index) => (
								<li key={step.label} className={styles[step.state]}>
									<span className={styles.mockDot} />
									<span className={styles.mockIndex}>{index + 1}</span>
									<span className={styles.mockLabel}>{step.label}</span>
									<span className={styles.mockState}>{step.state}</span>
								</li>
							))}
						</ol>
						<div className={styles.mockFoot}>
							<div className={styles.mockTrack}>
								<div className={styles.mockFill} />
							</div>
							<span>2 of 4 passed · 11m 42s · 0 human interrupts</span>
						</div>
					</div>
				</div>

				<div className={styles.heroCards}>
					{HERO_CARDS.map((card) => (
						<article key={card.title} className={styles.heroCard}>
							<span className={styles.heroCardIcon} aria-hidden="true">
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
									<path d={card.icon} strokeLinecap="round" strokeLinejoin="round" />
								</svg>
							</span>
							<div>
								<h2>{card.title}</h2>
								<p>{card.body}</p>
							</div>
						</article>
					))}
				</div>
			</header>

			<section className={styles.section} id="method" aria-labelledby="method-title">
				<p className={styles.eyebrow}>The method</p>
				<h2 className={styles.sectionTitle} id="method-title">
					The unit of work is the workflow, not the prompt
				</h2>
				<p className={styles.sectionLede}>
					Agents got good enough to do the work and stayed bad at deciding what the work is. WDD moves that
					decision back to you — once, up front — and leaves the agent the part it's actually good at.
				</p>
				<div className={styles.compare}>
					<article className={`${styles.compareCol} ${styles.before}`}>
						<h3>Prompt driven</h3>
						<ul>
							<li>One long prompt carries the whole goal, and the agent decides where to start.</li>
							<li>Context is re-explained every session, and quietly lost when the thread compacts.</li>
							<li>"Looks right" is the only quality gate there is.</li>
							<li>You sit in front of a terminal to know whether it's still alive.</li>
							<li>One bad turn poisons the rest, and you restart from zero.</li>
							<li>Nothing is measured, so nothing improves on purpose.</li>
						</ul>
					</article>
					<article className={`${styles.compareCol} ${styles.after}`}>
						<h3>Workflow driven</h3>
						<ul>
							<li>The goal is decomposed once into ordered steps you can read, reorder and re-run.</li>
							<li>One agent, one continuous conversation — step twenty still remembers step one.</li>
							<li>Every step is graded against a written criterion before the next one begins.</li>
							<li>The run is autonomous: it carries on in Docker while you do something else.</li>
							<li>A failed step retries alone, with the judge's reason attached.</li>
							<li>Every run leaves timings, verdicts and results behind.</li>
						</ul>
					</article>
				</div>
			</section>

			<section className={styles.section} id="pillars" aria-labelledby="pillars-title">
				<p className={styles.eyebrow}>How it holds up</p>
				<h2 className={styles.sectionTitle} id="pillars-title">
					Determinism you can inspect, autonomy you can leave alone
				</h2>
				<div className={styles.grid}>
					{PILLARS.map((pillar) => (
						<article key={pillar.title} className={styles.card}>
							<h3>{pillar.title}</h3>
							<p>{pillar.body}</p>
						</article>
					))}
				</div>
			</section>

			<section className={styles.section} aria-labelledby="how-title">
				<p className={styles.eyebrow}>The loop</p>
				<h2 className={styles.sectionTitle} id="how-title">
					How a run actually goes
				</h2>
				<ol className={styles.steps}>
					{HOW.map((item, index) => (
						<li key={item.title}>
							<span className={styles.stepNum}>{index + 1}</span>
							<div>
								<h3>{item.title}</h3>
								<p>{item.body}</p>
							</div>
						</li>
					))}
				</ol>
			</section>

			<section className={styles.band} id="features" aria-labelledby="features-title">
				<div className={styles.bandInner}>
					<p className={styles.eyebrow}>In the hub</p>
					<h2 className={styles.sectionTitle} id="features-title">
						Six things you'll use on every run
					</h2>
					<p className={styles.sectionLede}>
						The method is the point; these are the parts of it you actually click.
					</p>
					<div className={styles.grid}>
						{FEATURES.map((feature) => (
							<article key={feature.title} className={styles.card}>
								<h3>{feature.title}</h3>
								<p>{feature.body}</p>
							</article>
						))}
					</div>
				</div>
			</section>

			<section className={styles.cta} aria-labelledby="cta-title">
				<h2 id="cta-title">Run your first workflow today</h2>
				<p>
					Bring the harness you already use — Claude Code or free-code — point it at a repo, and give it three
					steps. Everything stays on this machine.
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
			</section>

			<footer className={styles.footer}>
				<p>
					The Target Project — Workflow Driven Development, running on your machine and staying on your machine.
				</p>
			</footer>
		</div>
	);
}
