# Handoff: autorización humana para `device-link/v1` en target-server

El hub ya implementa el lado dispositivo del contrato `device-link/v1`. Este
documento define el trabajo que debe hacerse en `target-server`. No se debe
intentar completar esta parte mediante cambios en el hub: la identidad humana,
su sesión y sus permisos sólo existen en el servidor.

## Resultado requerido

Al visitar `GET /link/device/:requestId`, una persona debe autenticarse con el
login existente del servidor (Google o email/contraseña). Al terminar el login,
el servidor debe resolver la cuenta existente y verificar el permiso
`devices.link`.

* Una cuenta autenticada que tiene `devices.link` aprueba atómicamente la
  solicitud **pendiente y no expirada** y recibe una página de confirmación.
  No hay botón ni confirmación adicional: el éxito del login autorizado es la
  aprobación.
* Una cuenta sin `devices.link` recibe `403 Forbidden` con una página/mensaje
  claro (“No tienes permiso para vincular dispositivos; solicita
  `devices.link` a un administrador”). La solicitud sigue `pending`, sin
  `approved_by`, sin dispositivo creado y sin credencial consumible.
* Abrir la URL sin sesión no aprueba nada. Debe iniciar el flujo de login y
  redirigir de vuelta a la misma ruta sólo después de autenticar.
* Cancelar o abandonar el login tampoco aprueba ni deniega la solicitud. Ésta
  queda pendiente hasta que caduque o el dispositivo la cancele.

La autorización se basa en el usuario ya autenticado y en su permiso efectivo,
no en que una dirección de correo exista ni en valores que lleguen desde la URL.
El `requestId` debe tratarse como identificador público opaco, no como
autorización.

## Cambios concretos en target-server

1. Añadir la ruta de navegador `GET /link/device/:requestId` dentro del
   middleware de sesión existente. Con sesión ausente, iniciar el login
   existente preservando como destino de retorno una ruta local validada
   (`/link/device/:requestId`), nunca una URL arbitraria proporcionada por el
   cliente.
2. Después del callback de Google/email, cargar la cuenta local existente y
   ejecutar el comprobador de permisos habitual con `devices.link`.
3. Con permiso, hacer una transición condicional y transaccional:
   `pending AND expires_at > now AND consumed_at IS NULL -> approved`.
   Guardar el id de cuenta auditado y `approved_at`; no guardar contraseña,
   cookie, JWT ni token humano junto a la solicitud o el dispositivo.
4. Con falta de permiso, responder `403` y no modificar la solicitud. Si la
   solicitud no existe, está expirada, o ya fue consumida, responder con su
   estado seguro sin revelar datos de otro dispositivo.
5. La aprobación debe ser idempotente para la misma solicitud: una nueva carga
   de un usuario autorizado ya aprobado puede mostrar confirmación, pero nunca
   crear un segundo dispositivo ni rotar credenciales.

## Contrato HTTP que no debe cambiar

El hub llama exclusivamente a estas rutas y formatos:

| Operación | Método y ruta | Respuesta esperada |
| --- | --- | --- |
| Iniciar | `POST /api/device-links/requests` | `201` con `request_id`, `state: "pending"`, `browser_url` sin query/fragment, `polling_credential`, `expires_at`, `poll_after_seconds` |
| Esperar | `POST /api/device-links/requests/:requestId/poll` | `200` y `state` `pending`, `approved`, `denied` o `expired`; requiere `Authorization: Target-Link <polling_credential>` |
| Consumir | `POST /api/device-links/requests/:requestId/consume` | Sólo tras aprobación: `200` con `device` y `device_secret`; requiere el mismo esquema `Target-Link` |
| Desconectar | `DELETE /api/device-links/devices/:deviceId` | Archiva/revoca sólo el dispositivo autenticado con `Target-Device v1`; `2xx`, `404` y `410` son éxito idempotente |
| Página humana | `GET /link/device/:requestId` | Sin sesión: redirección a login; autorizado: `200` de confirmación y aprobación; sin `devices.link`: `403` claro y sin mutación |

`poll` debe seguir devolviendo `pending` mientras un usuario no autorizado
recibe el `403`; no debe producir un `approved` ni una credencial. Una
solicitud aprobada se consume una única vez. Un `consume` antes de aprobar debe
fallar (por ejemplo `409`); tras caducidad o consumo debe fallar de forma
determinista (`410` o el código de estado que ya use el servidor). Para el hub
son esenciales el contrato y los cuerpos de éxito anteriores, además de la
versión `device-link/v1`, `Target-Link` y la clave pública `ed25519`.

La `polling_credential` y el `device_secret` son secretos de dispositivo:
aparecen sólo en las respuestas HTTPS correspondientes al hub, nunca en
`browser_url`, HTML, redirecciones, logs, trazas, mensajes de error ni
respuestas de la ruta humana. La sesión de navegador nunca se entrega al hub.

## Prueba de integración requerida en target-server

A reference simulation is executable now with:

```bash
cd hub
node --test --import ./test-setup.ts device-link-client.test.ts
```

The test `target-server handoff model approves only after existing authorized
login, without a hub click` drives the hub through `pending → approved →
consume`, models the login redirect, and asserts the `403`/pending path for a
read-only account. target-server should port the same assertions to its real
application and ephemeral database:

Añadir, por ejemplo, `test/integration/device-link-human-auth.test.ts`, usando
la aplicación y base de datos efímeras del servidor. Debe poder ejecutarse con
el comando de integración habitual de ese repositorio (o, si no existe,
`npm test -- device-link-human-auth.test.ts`).

El caso principal debe hacer, mediante HTTP simulada, lo siguiente:

1. Crear la solicitud mediante `POST /api/device-links/requests`; guardar sólo
   `request_id` y la credencial de polling dentro del cliente simulado.
2. Visitar `/link/device/:requestId` sin sesión y comprobar que redirige al
   login y que `poll` continúa en `pending`.
3. Simular el callback del login de una **cuenta existente** con
   `devices.link`. Al volver automáticamente a la ruta de enlace, comprobar
   `200` de confirmación, sin POST/click de aprobación adicional.
4. Comprobar que `poll` pasa a `approved`; ejecutar `consume` con
   `Target-Link` y comprobar `200` con una credencial de dispositivo. Repetir
   `consume` y comprobar que no entrega otra credencial.
5. Crear una segunda solicitud y repetir con una cuenta existente sin
   `devices.link`. Comprobar `403`, `poll: pending`, que `consume` no produce
   dispositivo/credencial y que la fila continúa pendiente.
6. Crear una tercera solicitud y visitar la URL sin completar login; comprobar
   que no se aprueba. Avanzar el reloj hasta `expires_at` y comprobar
   `poll: expired`.

Las aserciones de las respuestas/logs serializados deben confirmar que no
contienen contraseña, cookie de sesión, JWT de usuario ni la
`polling_credential`/`device_secret` fuera de las respuestas privadas al
cliente de dispositivo.
