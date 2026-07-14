# target

Define **workflows** hechos de N **steps** secuenciales. Reutiliza el mecanismo
de agentmesh (agente = hook de `agent-webhook-bridge`, step = job async con
callback) pero con un objetivo distinto: en vez de un registro de agentes
compartidos + cola de jobs sueltos, cada **workflow crea su propio agente +
hook dedicados**, y sus steps corren uno detrás del otro **sobre la misma
sesión de Claude** (`--resume` encadenado), como una única conversación que
avanza paso a paso.

## Piezas reusadas de agentmesh

- `hub/awb.ts` — igual que `agentmesh/hub/awb.ts`: crea/inspecciona hooks de
  `agent-webhook-bridge` escribiendo `~/.agent-webhook-bridge/hooks.json`.
- Mismo stack cero-dependencias: Node 24 + `node:sqlite` + TS ejecutado
  directo, mismo patrón de servidor HTTP a mano.
- Mismo modelo de callback asíncrono: el hook responde `{ok:true}` al toque,
  el resultado llega después a `POST /api/steps/:id/result`.

## Qué cambia respecto a agentmesh

| agentmesh | target |
|---|---|
| Agente = fila reusable en un registro | Agente = 1 por workflow, creado automáticamente al crear el workflow |
| Job = tarea suelta, sesión opcional | Step = tarea de un workflow, siempre encadenada a la sesión anterior |
| Jobs en paralelo, sin orden | Steps estrictamente secuenciales (el siguiente no dispara hasta que el anterior termina) |
| — | Progreso en % (done/total), pausar/reanudar, editar step + reiniciar workflow |
| — | Cada job lleva agregada la instrucción de resolverse con un subagente (Task tool), porque el hilo principal se reutiliza para todo el workflow |
| — | `.md` de estado en `~/.target/<slug-del-nombre>-<id>.md`, reescrito en cada cambio |

## Uso

```bash
cd hub && npm install
node daemon.ts        # o: npx tsx cli.ts start / node cli.ts start
```

El hub imprime su **admin token** al arrancar (también vive en
`~/.target/config.json`) — lo pide la UI y lo usa el CLI automáticamente.

```bash
node cli.ts create "release-notes" [--workdir <dir>] [--permission-mode acceptEdits]
node cli.ts add-step <workflowId> "Leer el CHANGELOG y armar un resumen"
node cli.ts add-step <workflowId> "Publicar el resumen en docs/release-notes.md"
node cli.ts run <workflowId>       # arranca / continúa
node cli.ts pause <workflowId>
node cli.ts resume <workflowId>
node cli.ts restart <workflowId>   # resetea todos los steps y arranca de cero
node cli.ts list
node cli.ts show <workflowId>
```

O desde la UI en `http://127.0.0.1:8893` (sección **Workflow**): crear
workflow, agregar steps con el botón `+ Agregar step`, ver la barra de
progreso, Start/Pause/Resume/Restart, y editar un step pendiente antes de
reiniciar.

### Permisos del agente

Por default el agente de un workflow puede responder pero **no** escribir
archivos ni correr comandos (mismo default conservador de agentmesh fase 1).
Para que los steps puedan de verdad escribir archivos en su sandbox dedicado
(`~/.target/sandboxes/<agente>/`), creá el workflow con
`--permission-mode acceptEdits` (o elegilo en el formulario de la UI).
`bypassPermissions` existe pero requiere confirmación explícita porque
habilita ejecución de comandos sin restricciones.

## Requisito externo

Necesita `agent-webhook-bridge` corriendo (`awb start`) — es quien realmente
spawnea `claude -p` / `claude --resume` para cada step.

## Estado del proyecto

Este repo está en etapas iniciales. Los issues de GitHub se usan para
trackear bugs y features pendientes; los PRs deben apuntar a `main`.
