# Plan: verificar actividad antes de declarar el timeout

> Estado: **listo para aplicar**. Diseño cerrado, con los cambios fichero por fichero, los
> snippets y los tests. No hay código implementado todavía.

## 1. Problema

Un step falla con `error: "timeout"` a los ~20 minutos aunque el agente **sigue trabajando**.
El hub mide un único reloj de pared desde el arranque del run y no observa ninguna señal de
actividad:

- `stepTimeoutMs` es fijo, 20 min (`hub/config.ts:23` y `:34`).
- `expireStaleSteps` (`hub/db.ts:657-678`) hace `SELECT` + `UPDATE` en la misma pasada: la
  condición es literalmente `status = 'running' AND started_at < ?`. El step está marcado
  `failed` antes de que nadie pueda comprobar nada.
- `started_at` lo fija el broker al arrancar de verdad (`promoteQueuedToRunning`,
  `hub/db.ts:531-537`, desde `POST /api/steps/:id/started`, `hub/server.ts:355-366`) y se
  **reinicia** al entrar en fase judge (`markStepJudging`, `hub/db.ts:547-554`).
- El modo normal de trabajo es delegar en un subagente (`SUBAGENT_SUFFIX`, `hub/runner.ts:26-27`),
  y un subagente de 40 min es, para el hub, indistinguible de un proceso colgado.

Con el retry añadido en `021943b`: en el mejor caso se quema presupuesto de reintentos matando un
run que iba bien (`abortAwbRun`, `hub/workflow.ts:104`); en el peor —`maxRetries` es **0 por
defecto**, `hub/db.ts:386`— el timeout falla el step *y* el workflow.

El barrido sólo corre en rutas de lectura (`hub/server.ts:565` y `:645`), y la UI hace polling cada
2 s (`hub/ui/src/App.tsx:34`, `:150-155`), así que en la práctica corre ~cada segundo con una
pestaña abierta.

## 2. Decisión

**Verificación de última hora**: no se vigila la actividad de forma continua; se sondea **una sola
vez, justo antes de matar el step**. `expireStaleSteps` se parte en dos fases:

```
candidatos (running, started_at < cutoff)  →  probe de disco  →  actividad reciente → no se toca
                                                              →  sin actividad      → camino actual
                                                                                       (retry budget / fail)
```

`stepTimeoutMs` deja de significar "cuándo se mata" y pasa a significar **"cuándo se empieza a
sospechar"**. Los steps `queued` no se sondean: su ruta (`queuedTimeoutMs`, 6 h) ya es justa y
queda intacta.

### 2.1 Qué pasa exactamente al llegar a los 20 minutos

El plazo **no se alarga ni se ignora**: deja de ser un plazo y pasa a ser un interruptor. Como
`findTimeoutCandidates` sigue devolviendo el step en cada barrido (`started_at < cutoff` ya es cierto
para siempre) y el barrido corre ~1/s con la UI abierta, a partir del minuto 20 el step queda bajo
**reevaluación continua**:

```
t=0 ─────────── stepTimeoutMs (20 min) ─────────────────────────── stepHardTimeoutMs (6 h)
   inmune                    │  vigilancia continua:                        │
   (ni se sondea)            │  ¿mtime más nuevo hace ≥ gracia? → muere     │ → muere sí o sí
```

Es decir: muere en el primer barrido en que el artefacto más nuevo lleve ≥ `stepActivityGraceMs`
sin tocarse. **Pasado el minuto 20 el timeout efectivo es la gracia (5 min), más estricto que los 20
min de hoy, no más laxo**: un agente que se cuelga en el minuto 25 muere sobre el 30, no sobre el 45.

`started_at` no se toca nunca, así que el tope duro se mide siempre desde el arranque real y la
actividad no puede "renovar" el step indefinidamente. Y como todo se recalcula en cada pasada, no hay
ningún plazo que guardar entre barridos — de ahí que el diseño no necesite columnas.

Corolario heredado de hoy: si nadie lee la API, no hay barrido y no muere nada (§7).

Consecuencias deliberadas de esta forma (frente a un watchdog de inactividad completo):

- **No hace falta persistir nada**: sin estado, "hay actividad" es simplemente
  `mtime del artefacto más nuevo > now - gracia`. Cero columnas nuevas, cero migración, cero
  resets en `markStepRunning` / `markStepQueued` / `promoteQueuedToRunning` / `markStepJudging` /
  `beginRetry` / `resetSteps` / `startManualRun` (ahí estaba la mitad del riesgo).
- **No mejora la latencia de detección de un cuelgue**: un run colgado sigue muriendo a los 20 min,
  igual que hoy. Lo que cambia es que deja de matar a los que trabajan, que es el bug reportado.
- El coste de I/O es despreciable porque sólo se sondea a steps que **ya** pasaron el timeout, y hay
  como mucho un step en vuelo por workflow (`hub/workflow.ts:414`).

## 3. Diseño

### 3.1 Configuración (`hub/config.ts`)

| Campo | Default | Significado |
|---|---|---|
| `stepTimeoutMs` | `20 * 60 * 1000` (sin cambios) | Cuándo un step `running` pasa a ser **candidato** a timeout |
| `stepActivityGraceMs` | `5 * 60 * 1000` | Un candidato se perdona si el harness escribió algo hace menos de esto |
| `stepHardTimeoutMs` | `6 * 60 * 60 * 1000` | Tope duro desde `started_at`: se mata aunque haya actividad |
| `queuedTimeoutMs` | `6 * 60 * 60 * 1000` (sin cambios) | — |

`stepHardTimeoutMs` **no es opcional**: sin él, un workdir compartido con otra sesión de Claude Code
daría "activo" para siempre y el step sería inmortal (ver §7).

No hace falta lógica de compatibilidad en `loadConfig`: `stepTimeoutMs` conserva su nombre y su
default, y un operador que lo hubiera subido a mano en `~/.target/config.json` sigue teniendo el
comportamiento que pidió (sólo que ahora con indulto). Los campos nuevos entran por el merge
`{...DEFAULTS, ...fileCfg}` que ya existe (`hub/config.ts:62-66`).

```ts
	/** A `running` step past `stepTimeoutMs` is only failed if the harness hasn't written anything for this long — the last-chance activity probe (progress.ts). */
	stepActivityGraceMs: number;
	/** Hard ceiling from `started_at`: a step older than this is failed even if it still looks active. Guards against a shared workdir whose OTHER Claude session keeps the artifacts warm forever. */
	stepHardTimeoutMs: number;
```

### 3.2 `hub/progress.ts` (nuevo)

Devuelve la señal de actividad más reciente que el harness haya dejado en disco, sin leer ni
parsear los `.jsonl` (basta `stat`; `readTokenUsage` sería mucho más caro).

Orden de sondeo, de la señal más fuerte a la más débil:

1. **Transcripts de Claude Code** — `~/.claude/projects/<slug(workdir)>`, resolviendo `workdir` con
   `hookRuntime(workflow.hookUrl)` (`hub/awb.ts:96-110`). Se toma el `max(mtimeMs)` de los `*.jsonl`
   de primer nivel **y** de `*/subagents/*.jsonl` (`hub/transcript.ts:137-147`), que es donde late
   el trabajo real. `kind: "transcript"`.
   Se observa el **árbol del proyecto**, no un fichero fijo: durante el run el hub no conoce el
   `session_id` (sólo llega en el callback final, `hub/server.ts:388-393`) y cada
   `claude --resume … -p` parece crear un `.jsonl` nuevo (hay varios por sandbox).
2. **Sesiones de free-code** — `<AWB_HOME>/sessions/<workflow.agentName>/*.jsonl`
   (el `sessionId` de free-code *es* la ruta del `.jsonl`, `hub/transcript.ts:157-162`).
   `kind: "session-file"`.
3. **Log del run en awb** — `<AWB_HOME>/logs/<workflow.agentName>-*.log`
   (`vendor/.../adapters/spawn-runner/claude.ts:47`). Señal fuerte para free-code (NDJSON
   incremental) y débil para claude (`--output-format json` escribe al final), pero no requiere
   resolver el workdir. `kind: "run-log"`.

Sin señal → `null` → el step se declara timeout exactamente como hoy (degradación segura: nunca
peor que el comportamiento actual).

```ts
/**
 * Last-chance activity probe: the newest thing the harness wrote for a
 * workflow's run. Used ONLY when a step has already blown past
 * `stepTimeoutMs`, to tell "still working" from "hung" before the sweep kills
 * it (see `expireStale` in workflow.ts). Cheap on purpose — `stat` only, never
 * a transcript parse — and best-effort: any fs error means "no signal", which
 * falls back to the plain wall clock.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { awbHome, hookRuntime } from "./awb.ts";
import type { Workflow } from "./db.ts";
import { claudeProjectDir } from "./transcript.ts";

export interface ActivitySignal {
	/** Epoch ms of the newest artifact, clamped to now (a future mtime must not read as "active forever"). */
	atMs: number;
	kind: "transcript" | "session-file" | "run-log";
	/** Artifact whose mtime won — logged when a step is spared or killed. */
	path: string;
}

/** The sweep runs on every workflow GET (~1/s with the UI open); one probe per workdir per 10s is plenty against a 5-minute grace. */
const CACHE_MS = 10_000;
const cache = new Map<string, { probedAt: number; signal: ActivitySignal | null }>();

export function probeActivity(workflow: Workflow, now = Date.now()): ActivitySignal | null {
	const hit = cache.get(workflow.id);
	if (hit && now - hit.probedAt < CACHE_MS) return hit.signal;
	const signal = probeUncached(workflow, now);
	cache.set(workflow.id, { probedAt: now, signal });
	return signal;
}

/** Forgets a workflow's cached probe — call when its steps are reset/deleted so a stale signal can't spare a brand-new run. */
export function forgetActivity(workflowId: string): void {
	cache.delete(workflowId);
}
```

`probeUncached` recorre las tres fuentes con un helper `newestFile(dir, filter, depth)` que hace
`readdirSync(dir, { withFileTypes: true })` + `statSync`, devuelve `{ atMs, path }` y traga
cualquier error. `atMs` se hace `Math.min(mtimeMs, now)`.

Requiere dos exports nuevos, ambos triviales:

- `claudeProjectDir` en `hub/transcript.ts:24` (hoy privada) — añadir `export`.
- `awbHome()` en `hub/awb.ts` — extraer de `awbConfigFile()` (`hub/awb.ts:34-36`) el
  `process.env.AWB_HOME ?? path.join(os.homedir(), ".agent-webhook-bridge")`, para que los tests
  puedan aislarlo igual que ya hacen con `AWB_HOME`.

### 3.3 `hub/db.ts`: partir el barrido en selección + fallo

`expireStaleSteps` se sustituye por dos funciones. La query de selección es **la misma condición de
hoy** más `started_at` en el `SELECT` para poder clasificar idle vs. tope duro en `workflow.ts`.

```ts
export interface TimeoutCandidate {
	stepId: string;
	workflowId: string;
	status: "running" | "queued";
	/** ISO; null only for a queued candidate. */
	startedAt: string | null;
}

/**
 * Steps whose timeout clock has run out — CANDIDATES, not victims: unlike the
 * old `expireStaleSteps` this only selects, so `expireStale` can probe a
 * `running` candidate for harness activity and spare it before anything is
 * marked failed (see workflow.ts). Two clocks, unchanged: `running` steps from
 * `started_at` (the real run start, reported by the broker's `started`
 * callback) against `stepTimeoutMs`, and `queued` steps from `queued_at`
 * against the much longer `queuedTimeoutMs` — a queued step is just waiting its
 * turn on the workdir lock and must NOT suffer the short countdown.
 */
export function findTimeoutCandidates(timeoutMs: number, queuedTimeoutMs: number): TimeoutCandidate[];

/**
 * Marks one timed-out step failed, keyed on the status it was selected with so
 * a callback that landed between the sweep's select and this write wins (the
 * step already settled itself; nothing to expire). Returns false when that
 * happened, so the caller skips the retry/fail bookkeeping.
 */
export function failTimedOutStep(stepId: string, status: "running" | "queued", error: string): boolean;
```

`failTimedOutStep` es el `UPDATE` de `hub/db.ts:670-676` acotado a un id:

```ts
	const res = open()
		.prepare(`UPDATE steps SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status = ?`)
		.run(error, new Date().toISOString(), stepId, status);
	return res.changes > 0;
```

Nada más cambia en `db.ts`: sin columnas nuevas, sin `rowToStep`, sin `addColumn`.

### 3.4 `hub/workflow.ts`: `expireStale` en dos fases

Reescribir el cuerpo de `expireStale` (`hub/workflow.ts:58-89`) manteniendo intacta toda la lógica
de retry budget y `retryTimedOutStep` (`:103-124`):

```ts
export function expireStale(cfg: HubConfig, log: Logger): void {
	const failedWorkflowIds = new Set<string>();
	for (const candidate of findTimeoutCandidates(cfg.stepTimeoutMs, cfg.queuedTimeoutMs)) {
		const workflow = getWorkflow(candidate.workflowId);
		const verdict = workflow ? timeoutVerdict(candidate, workflow, cfg) : { kill: true, error: "timeout" };
		if (!verdict.kill) {
			log(`step ${candidate.stepId} past its timeout but still active (${verdict.why}) — sparing it`);
			continue;
		}
		if (!failTimedOutStep(candidate.stepId, candidate.status, verdict.error)) continue; // settled meanwhile
		const step = getStep(candidate.stepId);
		if (step && workflow && step.retryCount < step.maxRetries) {
			…exactamente el bloque actual (beginRetry / writeStatusMd / log / retryTimedOutStep)…
			continue;
		}
		failedWorkflowIds.add(candidate.workflowId);
	}
	…el bucle actual de failedWorkflowIds + healSettledStatuses(log)…
}
```

Y la regla de decisión, en la misma función-módulo:

```ts
/**
 * Whether a step whose clock ran out really is hung. `queued` candidates are
 * never probed (they haven't started; there is nothing on disk to look at) and
 * a `running` one past `stepHardTimeoutMs` dies regardless — only the window in
 * between gets the reprieve, and only while the harness is still writing.
 */
function timeoutVerdict(candidate, workflow, cfg) {
	if (candidate.status === "queued") return { kill: true, error: "timeout (queued)" };
	const startedMs = candidate.startedAt ? Date.parse(candidate.startedAt) : Number.NaN;
	const elapsed = Number.isNaN(startedMs) ? 0 : Date.now() - startedMs;
	if (elapsed >= cfg.stepHardTimeoutMs) return { kill: true, error: `timeout (hard cap, ${minutes(elapsed)})` };
	const signal = probeActivity(workflow);
	if (!signal) return { kill: true, error: "timeout (no activity signal)" };
	const idle = Date.now() - signal.atMs;
	if (idle >= cfg.stepActivityGraceMs) {
		return { kill: true, error: `timeout (idle ${minutes(idle)}; last ${signal.kind} ${signal.path})` };
	}
	return { kill: false, why: `${signal.kind} touched ${seconds(idle)} ago` };
}
```

El `error` persistido siempre **empieza por `timeout`** (hay tests y docs que hablan de "timeout
error") pero ahora dice el motivo exacto. Ver §5: dos asserts pasan de `equal` a `startsWith`.

### 3.5 Observabilidad

- Log al perdonar un step: `step <id> past its timeout but still active (transcript touched 12s ago) — sparing it`.
  Corre en cada barrido; para no inundar el log, sólo se emite cuando el veredicto cambia respecto al
  anterior de ese step (un `Map<stepId, boolean>` en `workflow.ts`, mismo espíritu que la caché del probe).
- Log al matar: el `error` ya lleva `idleSeconds`/`kind`/ruta; añadir `retryCount/maxRetries` a la
  línea existente de retry, que ya los imprime.
- `writeStatusMd` (`hub/workflow.ts:158-195`) **no se toca** en esta fase: sin persistencia no hay
  nada que contar de un step que va bien.

## 4. Cambios fichero por fichero

| # | Fichero | Cambio |
|---|---|---|
| 1 | `hub/config.ts` | `stepActivityGraceMs` y `stepHardTimeoutMs` en `HubConfig` (`:17-27`) y en `DEFAULTS` (`:31-41`), con los comentarios de §3.1. Sin tocar `loadConfig`. |
| 2 | `hub/transcript.ts` | `export` en `claudeProjectDir` (`:24`). |
| 3 | `hub/awb.ts` | extraer y exportar `awbHome()` desde `awbConfigFile()` (`:34-36`). |
| 4 | `hub/progress.ts` | **nuevo**: `ActivitySignal`, `probeActivity`, `forgetActivity`, helpers de fs (§3.2). |
| 5 | `hub/db.ts` | sustituir `expireStaleSteps` (`:657-678`) por `findTimeoutCandidates` + `failTimedOutStep` (§3.3). |
| 6 | `hub/workflow.ts` | reescribir `expireStale` (`:58-89`) a dos fases + `timeoutVerdict` (§3.4); actualizar el import de `db.ts` (`:18`); llamar `forgetActivity(workflowId)` en `resetSteps`/`restartWorkflow` y en `deleteWorkflow`. |
| 7 | Docs | §6. |

Nada de UI, nada de `hub/server.ts`, nada de `hub/daemon.ts`, nada en `vendor/`.

Orden de aplicación: 1-3 (mecánicos) → 4 (+ su test) → 5 → 6 → tests → docs.

## 5. Tests

`npm test` (→ `node --test` en `hub/`) y `npm run typecheck`.

**`hub/progress.test.ts` (nuevo)** — `os.homedir()` respeta `$HOME` en POSIX y `awbHome()` respeta
`AWB_HOME`, así que el test apunta ambos a un `mkdtempSync` antes de importar los módulos (mismo
patrón que `hub/workflow.test.ts:19-22`):

- fabricar `<HOME>/.claude/projects/<slug>/<uuid>.jsonl` y
  `<HOME>/.claude/projects/<slug>/<uuid>/subagents/agent-x.jsonl`, tocar **el del subagente** con un
  mtime más reciente → `probeActivity` devuelve ese `atMs`, `kind: "transcript"` y esa ruta (es el
  caso real: el trabajo late en el subagente);
- sin `~/.claude/projects/<slug>` pero con `<AWB_HOME>/logs/<agentName>-1785003818744.log` →
  `kind: "run-log"`;
- workdir irresoluble y sin logs → `null`;
- mtime en el futuro → `atMs` clampado a `now` (idle nunca negativo);
- la caché: dos llamadas seguidas con el mismo `now` no vuelven a tocar el fs (tocar el fichero
  entre medias y comprobar que el resultado no cambió hasta `forgetActivity`).

**`hub/workflow.test.ts`** — el bloque de `:461-530` ya usa
`timeoutCfg = { ...cfg, stepTimeoutMs: -1000, queuedTimeoutMs: -1000 }`; hay que añadirle
`stepActivityGraceMs` y `stepHardTimeoutMs` (p. ej. `5 * 60 * 1000` y `6h`) y:

- **los cuatro tests existentes siguen pasando sin tocar su lógica**: sus workflows usan
  `hookUrl: "http://127.0.0.1:1/hook"`, que `inspectLocalHook` descarta por puerto → no hay workdir,
  no hay logs con ese `agentName` → probe `null` → se mata igual que hoy. Sólo cambian dos asserts:
  `assert.equal(…error, "timeout")` (`:495` y `:515`) → `assert.ok(…error?.startsWith("timeout"))`.
- **nuevo**: step `running` con `<AWB_HOME>/logs/<workflow.agentName>-<epoch>.log` recién escrito
  (el `AWB_HOME` del test ya es el tmpdir) → `expireStale(timeoutCfg)` **no** lo falla, sigue
  `running`, `retryCount` sigue en 0 y el workflow sigue `running`. Es la regresión del bug.
- **nuevo**: mismo caso pero con `stepHardTimeoutMs: -1000` → sí se falla, con `error` que contiene
  `hard cap`, y consume retry si lo hay.
- **nuevo**: mismo caso pero con el log envejecido (`fs.utimesSync` a hace 10 min) y
  `stepActivityGraceMs: 5 * 60 * 1000` → se falla, con `error` que contiene `idle`.
- **nuevo**: candidato `queued` con un log fresco → se falla igual (los `queued` no se sondean),
  preservando el comportamiento del test de `:519-530`.

Manuales (donde se ve el bug original):

1. Workflow con un step largo (>25 min) y `maxRetries: 0` → ya **no** falla; el log del hub muestra
   `sparing it` cada vez que el barrido lo mira.
2. Cuelgue real: `kill -STOP` al pid del run (tabla `runs` de `~/.agent-webhook-bridge/events.db`)
   → a los 20 min + gracia se declara timeout, se mata el run en el broker (liberando el `flock`) y
   se aplica el retry budget.
3. Broker muerto a mitad de run → sin artefactos nuevos → mismo camino que hoy.
4. Repetir 1 con `--runner free-code` (ruta `session-file`).

## 6. Documentación

- `docs/timeout-retries.md:40-41` — la frase "Both timeout clocks use the same rule" deja de ser
  cierta: describir el indulto por actividad y el tope duro.
- `README.md:170-194` — sección "Queued steps and a fair timeout clock": añadir que
  `stepTimeoutMs` es cuándo se sospecha, no cuándo se mata.
- `web-docs/index.html:595`, `:605-607`, `:629-630` (tabla de config) y su espejo `web-docs-es/`:
  filas nuevas para `stepActivityGraceMs` y `stepHardTimeoutMs`.

## 7. Riesgos

- **Workdir compartido**: `createWorkflow` usa un sandbox dedicado por defecto
  (`hub/workflow.ts:215`), pero el operador puede pasar un `workdir` propio; otra sesión de Claude
  Code en ese directorio se leería como progreso del step. Acotado por `stepHardTimeoutMs` (6 h),
  que es exactamente por lo que ese parámetro no es opcional.
- **Un agente colgado dentro de una tool larga** (un `Bash` que no termina) no escribe en el
  transcript → se declara timeout aunque el proceso viva. Es el compromiso aceptado, y es el
  comportamiento de hoy; `maxRetries` cubre el falso positivo.
- **Layout de transcripts**: `~/.claude/projects/<slug>/…` es un detalle interno de Claude Code (ya
  asumido por `hub/transcript.ts`). Si cambia, el probe devuelve `null` y todo vuelve al reloj de
  pared actual.
- **El barrido sigue corriendo sólo en rutas de lectura**: sin UI abierta no caduca nada. No cambia
  respecto a hoy; deliberadamente fuera de alcance (§8).
- **Relojes**: `mtime` es reloj local; `atMs` se clampa a `now` para que el idle nunca sea negativo.
- **Caché del probe (10 s)**: un step perdonado puede sobrevivir hasta 10 s de más tras colgarse.
  Irrelevante frente a una gracia de 5 min.

## 8. Fuera de alcance (posibles fases siguientes)

Todo esto queda explícitamente **fuera**, y ninguna de las piezas de arriba lo bloquea:

- **Watchdog de inactividad real** (matar a los 10 min sin escribir en vez de 20 min de reloj):
  reutiliza `hub/progress.ts` tal cual y añade `last_progress_at/_kind/_token` a `steps` con
  `addColumn` (`hub/db.ts:191-201`) + los resets de estado. Mejora la latencia de detección de
  cuelgues y libera antes el `flock`.
- **Indicador en la UI** (`activo hace 12s` / `sin actividad 6m`): se puede tener sin persistencia
  llamando al probe desde `publicStep` (`hub/server.ts:188-210`) para los steps `running`.
- **Barrido periódico en el daemon** (`setInterval` de 60 s) para que el hub caduque sin navegador.
- **Heartbeat explícito** (`POST /api/steps/:id/heartbeat` + POST periódico desde awb) o
  `--output-format stream-json`: sólo si la señal de disco resulta insuficiente en la práctica.
  Ambas tocan el repo vendorizado `vendor/agent-webhook-bridge`.
- **`idle_timeout_seconds` por step**, junto a `maxRetries`/`retryIntervalSeconds`.

## 9. Pendiente de confirmar antes de tocar el paso 4

Si `claude --resume … -p` reutiliza el mismo `.jsonl` o crea uno nuevo por turno. La evidencia en
disco (varios `.jsonl` por sandbox) sugiere que crea uno nuevo — por eso el probe observa el árbol
del proyecto y no un fichero fijo. Si resultara que reutiliza uno, el diseño sigue siendo correcto
(el `max` sobre un solo fichero es ese fichero); sólo sería una optimización posible.
