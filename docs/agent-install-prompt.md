# One-Prompt Agent Install

If you are not technical, you do not need to follow any guide. You need exactly two things:

1. An AI agent that can run shell commands (OpenCode, Codex CLI, Claude Code, Cursor, Cline, Aider, Roo Code, Hermes, Pi…)
2. The prompt below, pasted into that agent.

The agent will install **tuxevil-rotator** on your machine, walk you through the account logins (they are yours, so the browser steps stay with you), run it as a local service, and connect your coding agent to it. After that, your agent stops running out of quota as fast: the rotator pools and rotates the free quotas of the accounts you add.

> **⚠️ First read:** rotating accounts through this proxy may violate a provider's Terms of Service. Prefer non-primary accounts and keep usage modest. The prompt instructs the agent to warn you about this too; see the [README warning](../README.md#readme).

## What you end up with

| Piece | Where |
|-------|-------|
| Rotator CLI | `tuxevil-rotator` (npm global install) |
| Local endpoint for your agent | `http://127.0.0.1:51200/v1` (API key: any string, e.g. `tuxevil`, unless you use Virtual Keys) |
| Web dashboard | `http://localhost:51200/dashboard` |
| Admin token (auto-generated) | `~/.tuxevil-rotator/.admin-token` |
| Accounts, state | `~/.tuxevil-rotator/` |
| Systemd service (Linux) | `tuxevil-rotator.service` |

## The Prompt

Copy everything inside the fence and paste it into your AI agent:

```text
I am not technical, so explain your steps to me in plain language — one or two short
sentences before every command — and pause to ask me whenever only I can do something
(browser logins, passwords, API keys). You are installing tuxevil-rotator, an
open-source local proxy that pools and rotates the free quotas of my AI accounts so my
coding agent stops running out of quota. Project docs: https://github.com/tuxevil/tuxevil-rotator
(README.md and docs/).

Do these steps IN ORDER. If any step fails twice, stop and ask me — do not improvise.

STEP 0 — ASK ME FIRST (one question at a time, before changing anything)
1. What OS am I on? (Linux desktop/server, macOS, Windows, or Chromebook/other)
2. Which AI coding agent do I use today? (OpenCode, Codex CLI, Claude Code, Cursor,
   Cline, Roo Code, Continue, Aider, other)
3. Which of these do I already have, or am I willing to create now?
   - Google account(s) → free Claude/Gemini quota via Google Antigravity
   - Ollama Cloud API key → create free at https://ollama.com/settings/keys
   - ChatGPT account → OpenAI Codex OAuth pool
   - OpenCode Zen API key
   Only use the providers I approve. Even ONE Google account is enough to start.

STEP 1 — PREREQUISITES (no questions, just do it and tell me)
- Check `node -v`. Node.js 22 or newer is required. If missing or older, install
  Node 22 LTS the standard way for my OS (NodeSource on Debian/Ubuntu, Homebrew on
  macOS, nvm otherwise). Never uninstall or replace an existing Node setup.
- If npm global installs hit permission errors, fix it the safe way (user-owned npm
  prefix or nvm), not by pushing sudo blindly.

STEP 2 — INSTALL (no questions)
- Run `npm install -g tuxevil-rotator`
- Confirm `tuxevil-rotator --help` works.

STEP 3 — SECRETS (do it, never print full values in chat)
- Write an environment file at ~/.tuxevil-rotator/env (chmod 600) containing:
    TUXEVIL_ROTATOR_ENCRYPTION_KEY=<output of: openssl rand -hex 32>
    TUXEVIL_ROTATOR_ADMIN_TOKEN=<output of: openssl rand -hex 32>
- Explain: the admin token is my dashboard password. Never share or screenshot it.

STEP 4 — LOG IN MY ACCOUNTS (the part I must do with you)
- Run these commands one at a time, in the foreground, so the terminal interacts
  with me. Do NOT try to do the browser/OAuth part yourself and DO NOT ask me to
  paste passwords into chat. Guide me instead:
    Google Antigravity account:      tuxevil-rotator login
    (repeat for each extra Google account)
    Ollama Cloud API key:            tuxevil-rotator login --provider ollama
                                     (I get the key at https://ollama.com/settings/keys)
    ChatGPT Codex OAuth:             tuxevil-rotator login --provider openai-codex
    OpenCode Zen API key:            tuxevil-rotator login --provider opencode-zen
- After each login, verify the account appears with
  `tuxevil-rotator doctor`. If a login fails, tell me exactly what it says.

STEP 5 — RUN IT AS A BACKGROUND SERVICE (no questions)
- Linux with systemd: write /etc/systemd/system/tuxevil-rotator.service with:
    [Unit]
    Description=Tuxevil Rotator
    After=network-online.target
    Wants=network-online.target

    [Service]
    Type=simple
    User=<my username>
    Environment=TUXEVIL_ROTATOR_BIND_HOST=127.0.0.1
    EnvironmentFile=/home/<my username>/.tuxevil-rotator/env
    ExecStart=<absolute path from: command -v tuxevil-rotator> start
    Restart=always
    RestartSec=5

    [Install]
    WantedBy=multi-user.target
  then: sudo systemctl daemon-reload && sudo systemctl enable --now tuxevil-rotator
  and confirm `systemctl status tuxevil-rotator` is active.
- macOS (no systemd): start it with
    nohup tuxevil-rotator start > ~/.tuxevil-rotator/rotator.log 2>&1 &
  and tell me clearly that it dies on reboot unless we add a launchd agent — offer
  to create one if I want it to survive reboots.
- The service must stay bound to 127.0.0.1. Do not expose it to the network.

STEP 6 — VERIFY (no questions)
- `curl -s http://127.0.0.1:51200/v1/models` must list models.
- Send one real test request to
  POST http://127.0.0.1:51200/v1/chat/completions with header
  "Authorization: Bearer tuxevil", the body {"model":"<a small model from the list>",
  "messages":[{"role":"user","content":"ping"}]} and expect a normal completion.
- If anything fails: run `tuxevil-rotator doctor` and check the service log
  (journalctl -u tuxevil-rotator or ~/.tuxevil-rotator/rotator.log), fix it, and
  only then continue.

STEP 7 — CONNECT MY AGENT (ask me before writing any config file)
- First try the automatic configurator with --dry-run to preview, then for real:
    tuxevil-rotator install-agent --target auto
  It detects and configures OpenCode (~/.config/opencode), Hermes (~/.hermes),
  Pi (~/.pi/agent) and Codex (~/.codex) locally and backs up existing configs.
- If I use OpenCode, ALSO run `tuxevil-rotator install-opencode` so OpenCode
  discovers the rotator model catalog automatically.
- If my agent is not covered (Cursor, Claude Code, Cline, Roo Code, Continue,
  Aider, Open WebUI…), configure it manually with:
    Base URL:  http://127.0.0.1:51200/v1
    API key:   tuxevil  (any string works until Virtual Keys are enabled)
    Model:     pick a sensible default from /v1/models
  and follow https://github.com/tuxevil/tuxevil-rotator/blob/main/docs/integrations/<agent>.md
- Make the rotator the DEFAULT provider for my agent so every conversation uses
  it, and tell me how to switch back to my old provider if I ever want to.

STEP 8 — LEAVE ME WITH A CHEAT SHEET (plain language)
- My dashboard: http://localhost:51200/dashboard (sign in with the admin token in
  ~/.tuxevil-rotator/.admin-token)
- To add accounts later: run the matching `tuxevil-rotator login --provider …`,
  then `sudo systemctl restart tuxevil-rotator` (Linux) so the running service
  reloads the new accounts.
- If my agent ever loses quota again, check the dashboard's Overview "what needs
  you" list first — usually an account just needs its login refreshed.
- Honest risk reminder: this rotates accounts and can violate providers' Terms of
  Service. Recommend I use a non-primary Google account and keep usage modest.
- Finish with a checklist: what you installed, what you verified, anything that
  failed and why.

HARD RULES FOR YOU:
- Ask before overwriting or deleting ANY file; back up configs before editing.
- Never paste full keys/tokens into chat; show only the first characters.
- Do all browser/interactive logins WITH me, at human pace.
- Summarize progress in non-technical words each step.
```

## Short Version

Already comfortable, just want the fast path for one machine and one agent? Paste this instead:

```text
Install tuxevil-rotator (https://github.com/tuxevil/tuxevil-rotator) on this machine:
install Node 22+ if missing (`node -v`), then `npm install -g tuxevil-rotator`.
Set TUXEVIL_ROTATOR_ENCRYPTION_KEY and TUXEVIL_ROTATOR_ADMIN_TOKEN (both openssl rand -hex 32)
in ~/.tuxevil-rotator/env (chmod 600, never print full values).
Run `tuxevil-rotator login` (Google Antigravity) — interactive, so hand the browser
steps to me. Then start it persistently (systemd on Linux:
/etc/systemd/system/tuxevil-rotator.service, ExecStart=<command -v tuxevil-rotator> start,
EnvironmentFile=~/.tuxevil-rotator/env, TUXEVIL_ROTATOR_BIND_HOST=127.0.0.1, Restart=always;
on macOS use nohup). Verify with `tuxevil-rotator doctor` and
`curl -s http://127.0.0.1:51200/v1/models`. Then run
`tuxevil-rotator install-agent --target auto` (plus `tuxevil-rotator install-opencode` if I
use OpenCode) to point my agent at http://127.0.0.1:51200/v1 and make it the default
provider. Ask me before editing any existing config; back files up first.
```

## Versión en español

<details>
<summary>Prompt listo para pegar (español)</summary>

```text
No soy técnico, así que explícame cada paso en lenguaje simple — una o dos frases
antes de cada comando — y detente a preguntarme cuando solo yo pueda hacer algo
(logins en el navegador, contraseñas, claves de API). Vas a instalar tuxevil-rotator,
un proxy local de código abierto que junta y rota las cuotas gratuitas de mis cuentas
de IA para que mi agente de código deje quedarse sin cupo. Documentación del proyecto:
https://github.com/tuxevil/tuxevil-rotator (README.md y docs/).

Haz estos pasos EN ORDEN. Si algún paso falla dos veces, detente y pregúntame — no
improvises ni fuerces.

PASO 0 — PREGÚNTAME PRIMERO (de a una pregunta por vez, antes de cambiar nada)
1. ¿Qué sistema operativo uso? (Linux, macOS, Windows u otro)
2. ¿Qué agente de IA uso hoy? (OpenCode, Codex CLI, Claude Code, Cursor, Cline,
   Roo Code, Continue, Aider, otro)
3. ¿Cuáles de estas cuentas ya tengo, o estoy dispuesto a crear ahora?
   - Cuenta(s) de Google → cuota gratuita de Claude/Gemini vía Google Antigravity
   - Clave de API de Ollama Cloud → crear gratis en https://ollama.com/settings/keys
   - Cuenta de ChatGPT → pool OAuth de OpenAI Codex
   - Clave de API de OpenCode Zen
   Usa solo los proveedores que yo apruebe. Con UNA cuenta de Google ya se puede
   empezar.

PASO 1 — PRERREQUISITOS (sin preguntas; hazlo y avísame)
- Verifica `node -v`. Se requiere Node.js 22 o superior. Si falta o es más viejo,
  instala Node 22 LTS de la forma estándar para mi sistema (NodeSource en
  Debian/Ubuntu, Homebrew en macOS, nvm en otros). Nunca desinstales ni replaces
  un Node existente.
- Si npm da errores de permisos al instalar global, resuélvelo de forma segura
  (prefijo de npm del usuario o nvm), no uses sudo a ciegas.

PASO 2 — INSTALAR (sin preguntas)
- Ejecuta `npm install -g tuxevil-rotator`
- Confirma que `tuxevil-rotator --help` funciona.

PASO 3 — SECRETOS (hazlo; nunca muestres los valores completos en el chat)
- Crea el archivo de entorno en ~/.tuxevil-rotator/env (chmod 600) con:
    TUXEVIL_ROTATOR_ENCRYPTION_KEY=<salida de: openssl rand -hex 32>
    TUXEVIL_ROTATOR_ADMIN_TOKEN=<salida de: openssl rand -hex 32>
- Explícame: el admin token es la contraseña de mi panel web. Nunca lo compartas
  ni lo mandes en capturas de pantalla.

PASO 4 — INICIAR SESIÓN EN MIS CUENTAS (lo hacemos juntos)
- Ejecuta estos comandos de a uno, en primer plano, para que la terminal interactúe
  conmigo. NO intentes hacer la parte del navegador/OAuth tú mismo y NO me pidas
  pegar contraseñas en el chat; guíame en su lugar:
    Cuenta de Google Antigravity:    tuxevil-rotator login
    (repite por cada cuenta de Google extra)
    Clave de Ollama Cloud:           tuxevil-rotator login --provider ollama
                                     (creo la clave en https://ollama.com/settings/keys)
    OAuth de OpenAI Codex:           tuxevil-rotator login --provider openai-codex
    Clave de OpenCode Zen:           tuxevil-rotator login --provider opencode-zen
- Tras cada login, verifica que la cuenta aparezca con `tuxevil-rotator doctor`.
  Si un login falla, dime exactamente qué dice el error.

PASO 5 — DEJARLO CORRIENDO COMO SERVICIO (sin preguntas)
- Linux con systemd: escribe /etc/systemd/system/tuxevil-rotator.service con:
    [Unit]
    Description=Tuxevil Rotator
    After=network-online.target
    Wants=network-online.target

    [Service]
    Type=simple
    User=<mi usuario>
    Environment=TUXEVIL_ROTATOR_BIND_HOST=127.0.0.1
    EnvironmentFile=/home/<mi usuario>/.tuxevil-rotator/env
    ExecStart=<ruta absoluta de: command -v tuxevil-rotator> start
    Restart=always
    RestartSec=5

    [Install]
    WantedBy=multi-user.target
  luego: sudo systemctl daemon-reload && sudo systemctl enable --now tuxevil-rotator
  y confirma que `systemctl status tuxevil-rotator` esté activo.
- macOS (sin systemd): arranca con
    nohup tuxevil-rotator start > ~/.tuxevil-rotator/rotator.log 2>&1 &
  y avísame claramente que muere al reiniciar a menos que creemos un agente de
  launchd — ofrécete a crearlo si quiero que sobreviva a los reinicios.
- El servicio debe quedar atado a 127.0.0.1. No lo expongas a la red.

PASO 6 — VERIFICAR (sin preguntas)
- `curl -s http://127.0.0.1:51200/v1/models` debe listar modelos.
- Haz una prueba real contra POST http://127.0.0.1:51200/v1/chat/completions con
  el header "Authorization: Bearer tuxevil" y el cuerpo
  {"model":"<un modelo chico de la lista>","messages":[{"role":"user","content":"ping"}]}
  y espera una respuesta normal.
- Si algo falla: corre `tuxevil-rotator doctor`, mira el log del servicio
  (journalctl -u tuxevil-rotator o ~/.tuxevil-rotator/rotator.log), arréglalo y
  recién ahí continúa.

PASO 7 — CONECTAR MI AGENTE (pregúntame antes de escribir cualquier archivo de config)
- Primero prueba el configurador automático con --dry-run para previsualizar, y
  luego en serio: `tuxevil-rotator install-agent --target auto`
  Detecta y configura OpenCode (~/.config/opencode), Hermes (~/.hermes),
  Pi (~/.pi/agent) y Codex (~/.codex) localmente y hace backup de las configs.
- Si uso OpenCode, TAMBIÉN corre `tuxevil-rotator install-opencode` para que
  OpenCode descubra el catálogo de modelos del rotador automáticamente.
- Si mi agente no está cubierto (Cursor, Claude Code, Cline, Roo Code, Continue,
  Aider, Open WebUI…), configúralo a mano con:
    Base URL:  http://127.0.0.1:51200/v1
    API key:   tuxevil  (cualquier cadena funciona hasta activar Virtual Keys)
    Modelo:    elige un default sensato de /v1/models
  y sigue https://github.com/tuxevil/tuxevil-rotator/blob/main/docs/integrations/<agente>.md
- Deja el rotador como proveedor DEFAULT de mi agente y explícame cómo volver a
  mi proveedor anterior si algún día quiero.

PASO 8 — DÉJAME UNA CHULETA (en lenguaje simple)
- Mi panel: http://localhost:51200/dashboard (inicio de sesión con el admin token
  guardado en ~/.tuxevil-rotator/.admin-token)
- Para agregar cuentas después: corre el `tuxevil-rotator login --provider …`
  que corresponda y luego `sudo systemctl restart tuxevil-rotator` (Linux) para
  que el servicio en ejecución recargue las cuentas nuevas.
- Si me vuelvo a quedar sin cupo, mira primero la lista "what needs you" de la
  pestaña Overview del panel — casi siempre es que una cuenta necesita refrescar
  su login.
- Recordatorio honesto de riesgo: esto rota cuentas y puede violar los Términos
  de Servicio de los proveedores. Recomiéndame una cuenta de Google secundaria y
  mantener un uso moderado.
- Termina con una lista de verificación: qué instalaste, qué verificaste y qué
  falló, con por qué.

REGLAS DURAS PARA TI:
- Pregunta antes de sobrescribir o borrar CUALQUIER archivo; haz backups antes.
- Nunca pegues claves o tokens completos en el chat; muestra solo los primeros
  caracteres.
- Los logins interactivos se hacen CONMIGO, al ritmo de una persona.
- Resume el progreso en palabras no técnicas en cada paso.
```

</details>

## Notes for whoever runs the prompt

- **Windows:** the account logins and `install-agent` expect a Unix shell. The comfortable paths are WSL2 (follow the Linux steps inside Ubuntu) or the prebuilt Docker image (`docker compose up -d` — see [Deployment](deployment.md)). The prompt will make the agent ask about your OS first.
- **Headless / SSH servers:** account logins open browser URLs. Run them from a machine where you can open a browser, then wire up remote agents with `tuxevil-rotator install-agent --target auto --host <host> --user <ssh-user>` (use `--rotator-url http://<server>:51200` if the agent lives on a different machine than the rotator).
- **PostgreSQL / Virtual Keys are optional.** Out of the box the rotator runs file-based with no API-key gate; only set up [PostgreSQL](integrations/setup-postgresql.md) if you want [Virtual Keys](virtual-keys.md) and spend auditing for teams or CI.
- **If something goes wrong**, the resident checklist lives in [Troubleshooting](troubleshooting.md), and `tuxevil-rotator doctor` diagnoses the most common issues.
- The prompt pins every interactive step to the human on purpose: the agent installs and wires things up, but never performs OAuth logins or handles raw credentials for you.

## Related docs

- [Adding accounts](adding-accounts.md) — what each provider login does
- [Deployment](deployment.md) — Docker, systemd, reverse proxy details
- [Configuration](configuration.md) — routing policies, model aliases, compression
- [Troubleshooting](troubleshooting.md) — resident checklist when requests fail
