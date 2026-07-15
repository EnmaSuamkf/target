# target — Resumen del proyecto

## Qué es

**target** es un hub local para definir **workflows** compuestos por N **steps**
secuenciales ejecutados por Claude. Reutiliza el mecanismo de **agentmesh**
(agente = hook de `agent-webhook-bridge`, step = job asíncrono con callback),
pero con un objetivo distinto: en vez de un registro
de agentes compartidos con una cola de jobs sueltos, **cada workflow crea su
propio agente + hook dedicados**, y sus steps corren uno detrás del otro sobre la
**misma sesión de Claude** (`--resume` encadenado), de modo que el workflow
completo se lee como una única conversación que avanza paso a paso. El hub expone
una API HTTP, una UI web de una sola página y un CLI; además mantiene, por cada
workflow, un archivo `.md` de progreso en `~/.target/` que se reescribe en cada
cambio de estado.

## Stack

Node.js >= 24, TypeScript ejecutado directamente por Node (sin paso de build) y
**cero dependencias de runtime**. Todo se apoya en la biblioteca estándar:
`node:sqlite` (`DatabaseSync`, en modo WAL) para la persistencia, `node:http`
para el servidor escrito a mano, `node:crypto` para tokens y secretos, y `fetch`
global para hablar con el broker. Las únicas dependencias son de desarrollo:
`typescript` y `@types/node`. La UI es un `index.html` estático de ~750 líneas
servido por el propio hub, sin framework ni bundler.

Como requisito externo necesita **`agent-webhook-bridge` (awb)** corriendo
(`awb start`): es quien realmente spawnea `claude -p` / `claude --resume` para
cada step.

## Arquitectura

El flujo es asíncrono de punta a punta. El hub despacha un step al hook de awb
del workflow; el hook responde `{ok:true}` al toque (solo significa "aceptado") y
el resultado real llega después a `POST /api/steps/:id/result` mediante el
`callbackUrl` que el hub envió en el evento. Los módulos, en `hub/`:

- **`daemon.ts`** — punto de entrada; carga config, levanta el servidor e imprime
  el admin token.
- **`server.ts`** — servidor HTTP: API JSON (workflows, steps, start/pause/
  resume/restart, transcript, callback de resultados) y la UI. Toda ruta que
  muta pide el admin token como Bearer; el callback de awb se autentica en
  cambio con un token por step vía query string, comparado con
  `timingSafeEqual`.
- **`workflow.ts`** — el motor y la máquina de estados
  (`draft → running → paused/completed/failed`). `advance()` es el único lugar
  que decide qué corre después, así que "pausar" es simplemente no llamarlo.
  También vive acá la lógica del juez y la reescritura del `.md` de progreso.
- **`runner.ts`** — despacha un step (o su evaluación) al hook: arma el input,
  adjunta el `sessionid` a reanudar y el `callbackUrl`, y marca el step
  `running` o `failed` según la respuesta del hook.
- **`db.ts`** — capa de almacenamiento pura sobre SQLite: tablas `workflows` y
  `steps`, migraciones aditivas por `ALTER TABLE` para bases viejas, y expiración
  **lazy** de steps colgados (cada lectura falla primero los `running` más viejos
  que el timeout, en vez de un timer por step — sobrevive gratis a reinicios del
  hub).
- **`awb.ts`** — puente con la instalación local de awb: crea/inspecciona/borra
  hooks escribiendo directamente `~/.agent-webhook-bridge/hooks.json` (el broker
  relee el archivo en cada request, así que un hook nuevo queda vivo sin
  reiniciar nada).
- **`transcript.ts`** — lee, en modo best-effort y solo lectura, el `.jsonl` que
  Claude Code escribe para una sesión (bajo `~/.claude/projects/<slug>/`), para
  mostrar la conversación real dentro de los steps y no solo el resultado final.
- **`config.ts`** — config persistida en `~/.target/config.json` (override del
  directorio con `TARGET_HOME`); default `127.0.0.1:8893`, timeout de step de 10
  minutos. El puerto se eligió lejos del de awb (8890) y del de agentmesh-hub
  (8892) para que los tres convivan.
- **`cli.ts`** — CLI `target`; habla con la API y toma el admin token directo de
  `~/.target/config.json`, así no hay token que tipear.

### Detalles de diseño que conviene conocer

**Delegación a subagente.** Como la sesión se reutiliza turno tras turno, el
input de cada step agrega una instrucción explícita de resolver el trabajo con la
herramienta Task en lugar de hacerlo inline: eso mantiene el contexto de trabajo
de cada step fuera de la sesión reanudada, que solo acumula los resúmenes finales
del subagente.

**Juez / autoevaluación.** Un step puede llevar un criterio de aceptación
opcional. Si lo tiene, al terminar su ejecución (fase `exec`) el step no pasa a
`done`: entra en fase `judge` y se despacha una segunda corrida, sobre la misma
sesión, que le pide al agente evaluar su propio resultado y responder un JSON
`{"ok": bool, "reason": string}`. Si el veredicto acepta, el step queda `done` y
el motor avanza; si rechaza, se reintenta el mismo step con el feedback del juez
hasta agotar `maxRetries`, y recién ahí falla el workflow. Un veredicto que no
parsea también falla el workflow, deliberadamente, en vez de adivinar. Sin
criterio de aceptación no hay juez y el comportamiento es el de siempre.

**Corridas bajo demanda (▶).** Un step puede correrse fuera de orden. Esa corrida
usa el mismo agente/hook pero **siempre una sesión fresca**: nunca reanuda
`lastSessionId` ni se convierte en la nueva. Queda fuera del motor y no toca el
estado del workflow; `maybeMarkCompleted()` reconcilia después el caso en que
todos los steps terminan `done` sin haber pasado por `advance()`.

**Permisos.** Por default el agente de un workflow puede responder pero **no**
escribir archivos ni correr comandos. Para que los steps escriban de verdad en su
sandbox dedicado (`~/.target/sandboxes/<agente>/`) hay que crear el workflow con
`--permission-mode acceptEdits`. `bypassPermissions` existe pero exige confirmación
explícita (`acceptBypassRisk: true` / `--yes-bypass-risk`) porque habilita
ejecución de comandos sin restricciones en la máquina del operador.

## Estructura de directorios

```
/
├── README.md              Documentación principal (uso, diferencias con agentmesh)
├── .claude/               settings.local.json (allowlist de permisos)
└── hub/                   Todo el código
    ├── daemon.ts          Entry point del hub
    ├── server.ts          API HTTP + UI
    ├── workflow.ts        Motor, máquina de estados, juez, .md de progreso
    ├── runner.ts          Despacho de steps al hook de awb
    ├── db.ts              SQLite (workflows + steps)
    ├── awb.ts             Puente con agent-webhook-bridge
    ├── transcript.ts      Lectura de transcripts de sesiones de Claude
    ├── config.ts          Config persistida en ~/.target
    ├── cli.ts             CLI `target`
    └── ui/index.html      UI web (página única, sin build)
```

En tiempo de ejecución el hub usa `~/.target/`: `config.json`, `target.db`,
`sandboxes/<agente>/` y un `<slug>-<id>.md` de progreso por workflow.

## Cómo correrlo

```bash
cd hub && npm install
node daemon.ts        # o: npm start / node cli.ts start
```

El hub imprime su **admin token** al arrancar (también vive en
`~/.target/config.json`) — lo pide la UI y lo usa el CLI automáticamente. La UI
queda en `http://127.0.0.1:8893`. Requiere `agent-webhook-bridge` corriendo
(`awb start`).

Vía CLI:

```bash
node cli.ts create "release-notes" [--workdir <dir>] [--permission-mode acceptEdits]
node cli.ts add-step <workflowId> "Leer el CHANGELOG y armar un resumen"
node cli.ts run <workflowId>       # arranca / continúa
node cli.ts pause <workflowId>
node cli.ts resume <workflowId>
node cli.ts restart <workflowId>   # resetea todos los steps y arranca de cero
node cli.ts list
node cli.ts show <workflowId>
```

Verificación de tipos: `npm run typecheck` (`tsc --noEmit`). **No hay suite de
tests ni CI en el repo**; tampoco hay paso de build (Node ejecuta los `.ts`
directamente).

## Estado actual y foco reciente

El README lo declara **en etapas iniciales**: los issues de GitHub se usan para
trackear bugs y features pendientes, y los PRs apuntan a `main`. El repo es chico
y joven (~2.900 líneas, 6 commits desde el scaffold inicial) y varios comentarios
hablan de una "fase 1" local-only, con una fase 2 prevista para nodos remotos que
registren sus propios hooks.

El historial reciente muestra un foco claro en el **control fino sobre steps
individuales**: primero borrado completo de workflows y ejecución aislada de un
step; después una simplificación de ese mecanismo (se reemplazaron las columnas y
el callback separados de "isolated run" por un simple `manualRun` que reutiliza
`status`/`result`/`error` del step, más la reconciliación del estado del
workflow); y encima de eso la **autoevaluación de steps con criterio de aceptación
y reintentos** — el trabajo de la rama actual, `feat/step-acceptance-criteria-judge`.
El commit más reciente hace que el transcript muestre la sesión del step que corrió
más recientemente, en vez de solo la sesión compartida del workflow.
