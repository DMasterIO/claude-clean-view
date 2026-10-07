# Clean View

Mod de Claude Code que hace la experiencia más tranquila para personas no técnicas. Mientras Claude trabaja, oculta las llamadas a herramientas, los diffs y la salida de comandos, y muestra sobre el prompt un único checklist con el plan, lo que está pasando ahora y cuánto falta.

```
Build my landing page · 1m 12s                     [ ● Clean View: ON ]
✓ Read your brand notes            ██████████  Done
▶ Build the pricing section        ██████░░░░  60%
○ Add the contact form             ░░░░░░░░░░  Next
○ Polish the footer                ░░░░░░░░░░  Up next
```

Es un plugin de function hooks que se recarga en caliente. No usa hooks de shell ni servidores MCP.

## Estados del encabezado

| Estado | Qué muestra |
|---|---|
| Working | Nombre del trabajo y tiempo transcurrido |
| Needs you | Insignia resaltada `Needs you` y el motivo (por ejemplo, "Claude needs your OK to continue"). El paso actual cambia `▶` por `‖` |
| Stuck | `⚠ Stuck:` y el motivo en una frase simple |
| Stopped | `■ Stopped` con el nombre del trabajo y "you pressed Esc" |
| Done | `✓ All done` con el nombre y la duración. A los 5 segundos se reduce a una línea |

Pasos del checklist:

- **Hecho:** check verde, nombre atenuado, medidor lleno y "Done".
- **Actual:** `▶`, nombre en negrita y medidor que se llena según el porcentaje reportado. Sin porcentaje, el medidor muestra una barrida en movimiento y la etiqueta dice "Working".
- **Siguientes:** atenuados. El primero dice "Next" y el resto "Up next".

## Requisitos

- Claude Code con soporte de plugins de function hooks (API en acceso anticipado, puede cambiar entre versiones).
- Terminal o pestaña Code de la app de escritorio. El checklist se dibuja en ambas superficies.

## Instalación

### Desde este repositorio (recomendado)

En una sesión de Claude Code en terminal:

```
/plugin install clean-view --marketplace DMasterIO/claude-clean-view
```

Responde `y` para agregar el marketplace y elige el alcance de usuario. El mod queda activo en esa sesión y en las siguientes.

### Desde una carpeta local (desarrollo)

```bash
git clone https://github.com/DMasterIO/claude-clean-view.git
claude --plugin-dir ./claude-clean-view
```

Con `--plugin-dir` el mod solo vive durante esa sesión y se recarga al guardar cambios.

## Uso

Clean View parte encendido y recuerda tu elección entre reinicios.

- **Botón** `● Clean View: ON/OFF` a la derecha del encabezado, visible siempre, incluso sin trabajo en curso. Un clic lo enciende o apaga y muestra un aviso breve.
- **Comando** `/simple on`, `/simple off`. Sin argumento, invierte el estado actual.

Apagado, vuelven todas las filas ocultas, la barra se dibuja como siempre y solo queda el botón.

## Cómo funciona

1. **Dos herramientas para Claude**, registradas al iniciar la sesión:
   - `plan_steps({ steps })`: Claude declara de 2 a 8 pasos por adelantado. El primero parte de inmediato.
   - `report_progress({ task, percent })`: reporta avance del paso actual (0 a 100). Al reportar un paso, los anteriores quedan hechos; al llegar a 100 el paso se marca hecho y parte el siguiente. Un nombre que no está en el plan se agrega como paso nuevo.
2. **Instrucciones al modelo.** Mientras está encendido, una sección del system prompt pide nombres de paso en inglés simple, de menos de 40 caracteres, que empiecen con verbo y sin rutas, archivos, comandos ni nombres de herramientas.
3. **Plan primero.** Hasta que exista un plan real, se rechaza toda herramienta del agente principal con un mensaje que pide llamar a `plan_steps`. Siempre se permiten `ToolSearch`, `TodoWrite`, `TaskCreate`, `TaskUpdate` y `AskUserQuestion`. Los subagentes no se filtran.
4. **El checklist se llena con lo que Claude ya hace.**
   - Al enviar un prompt (no un slash command) se inicia un trabajo con pasos provisorios ("Understand your request", "Plan the steps"). En segundo plano, Haiku propone un nombre de 2 a 6 palabras para el encabezado.
   - `TodoWrite`, `TaskCreate` y `TaskUpdate` se convierten en filas del checklist.
   - Permisos y preguntas pasan a `Needs you` y se limpian cuando corre la siguiente herramienta o respondes.
   - Si dices que no a un permiso, aparece `Stuck`. Tres fallos seguidos también. Un éxito limpia el estado.
   - Al terminar el turno, los errores de API se traducen a una frase tranquila (límite de uso, servidores ocupados, contexto muy largo con `/compact`, red caída, `/login`). Un rechazo del modelo, un Esc y pasos sin terminar tienen su propio mensaje; si no queda nada pendiente, `All done`.
5. **Filas técnicas ocultas.** `ToolUse`, `ToolResult` y `ToolGroup` no se dibujan, y la pista de `ToolProgress` queda en blanco. Las respuestas escritas de Claude siguen visibles.

### Nombres de pasos

Todo nombre pasa por un limpiador: quita código entre backticks, cualquier cosa con barra y nombres de archivo con extensión de código, colapsa espacios y pone mayúscula inicial. Si pasa de 40 caracteres, se corta en un límite de palabra y se agrega `…`. Si no queda nada, usa "Working on it".

### Animación y ancho

Un reloj de 250 ms avanza el cuadro de animación solo mientras hay un trabajo en marcha o esperando respuesta. En reposo no corre ningún timer. La columna del nombre se ajusta a `bodyColumns` y el medidor siempre mide 10 celdas, así que las filas no se parten. Si la barra muestra una encuesta, el mod no interviene.

### Estado compartido

El estado vive bajo la clave `clean-view` en `$.state`, tipado en `types/index.d.ts`, de modo que otros mods puedan leer el checklist:

- `cleanViewEnabled`: booleano.
- `checklist`: `title`, `phase`, `tasks` (`id`, `name`, `status`, `percent`, `hasReported`), `needsYouReason`, `stuckReason`, `startedAt`, `finishedAt`, `isCollapsed`.
- `tick`: contador de animación.

El valor de `cleanViewEnabled` se guarda además con `$.store` para sobrevivir reinicios.

## Estructura del repositorio

```
.claude-plugin/plugin.json        manifest del plugin
.claude-plugin/marketplace.json   permite instalarlo con /plugin install
hooks/hooks.json                  apunta al módulo de hooks
hooks/register.tsx                punto de entrada: llama a registerCleanView(on)
hooks/clean-view.tsx              toda la lógica del mod
types/index.d.ts                  contrato del estado compartido
tests/clean-view.test.ts          tests (claude plugin test)
```

`register.tsx` existe para poder sumar otros mods al lado de `clean-view.tsx` más adelante.

## Desarrollo

```bash
claude plugin validate .   # valida manifest y módulo
claude plugin test .       # corre los tests
```

Los tests cubren el limpiador de nombres, el avance `plan_steps` más `report_progress`, el filtro de "plan primero", el render de filas en terminal y escritorio, `Needs you` ante un permiso y `/simple off`.

Para chequear tipos con `tsc`, el motor genera `.claude-plugin/types/` al cargar el mod desde una carpeta propia (ignorada por git). El `tsconfig.json` del repo extiende ese archivo, así que corre `tsc -p .` después de cargarlo una vez.

Convenciones del código: solo funciones de primer nivel reciben `$` (lo exige el validador), y los átomos de estado declaran `plugin` y `key` como literales.

## Limitaciones conocidas

- La API de plugins de function hooks está en acceso anticipado y puede cambiar.
- El filtro de "plan primero" no tiene `.catch`: si el hook fallara, deja pasar la herramienta en lugar de bloquear la sesión.
- Los pasos de `TaskCreate` y `TaskUpdate` se emparejan por el id que devuelve `TaskCreate`.
- Si Claude termina sin reportar 100 en el último paso, el encabezado muestra "Claude is waiting for your reply" en vez de `All done`.

## Aportes

Los aportes son bienvenidos.

1. Abre un issue describiendo el cambio o el problema, con la versión de Claude Code y la superficie (terminal o escritorio).
2. Haz un fork y crea una rama desde `main`.
3. Mantén los tests en verde: `claude plugin validate .` y `claude plugin test .`. Agrega un test para cada comportamiento nuevo.
4. Mensajes de commit en español, con tipo y descripción en infinitivo, por ejemplo `feat: agregar ...` o `fix: corregir ...`.
5. Abre un pull request explicando qué cambia y por qué.

## Licencia

Aún no se ha definido una licencia. Hasta que se agregue un archivo `LICENSE`, todos los derechos quedan reservados por la persona autora.
