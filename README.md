# Universal Code Runner — edición Railway

Panel Liquid Glass + backend que ejecuta proyectos reales (bots, servidores, webs, scripts) como **procesos aislados dentro de tu servicio de Railway**.
Railway no permite Docker dentro del contenedor, así que esta versión no usa Docker: cada proyecto corre con su propio usuario Linux, límite de RAM y reinicio automático.

## Desplegar en Railway (5 pasos)
1. Sube esta carpeta a un repo de GitHub → Railway → **New Project → Deploy from GitHub repo**. Railway detecta el `Dockerfile` y `railway.json`.
2. **Settings → Networking → Generate Domain**.
3. **Volumes → Add Volume**, ruta de montaje `/data` (sin esto, proyectos y secretos se borran en cada deploy).
4. (Recomendado) **Variables**: `ADMIN_TOKEN` = una contraseña larga. Si no la pones, se genera sola y se imprime en los logs del deploy.
5. Mira **Deploy Logs**: al terminar verás el recuadro `🌐 Abre tu web: https://tu-app.up.railway.app`.

Opcionales (variables de build): `INSTALL_RUST=1`, `INSTALL_DOTNET=1` (aumentan mucho el tiempo/tamaño de build).

## Uso
Entra con el token → **Subir** un ZIP (o archivo suelto, o URL de Git) → se detecta lenguaje y librería → **Variables** (añade `DISCORD_TOKEN`) → **Iniciar**.

## Qué incluye
- Ventanas movibles/redimensionables, dock tipo iOS en móvil, paneles Liquid Glass.
- Runtimes en la imagen: Node/TS, Python, Go, Java (Maven/Gradle), PHP, Ruby, Lua, Perl, Bash, C/C++ (+ Rust y C# opcionales), HTML estático.
- Detección de librerías: discord.js, discord.py, Pycord, Disnake, Nextcord, Eris, Oceanic, JDA, Discord4J, Discord.Net, DSharpPlus, Serenity, Twilight, Telegraf, grammY, aiogram, Slack Bolt, tmi.js, Mineflayer…
- Estado real (PID vivo, código de salida, reinicios), CPU/RAM por proyecto, corte si supera el límite de RAM, reinicio automático con espera creciente.
- Los procesos se **restauran solos** tras cada deploy/reinicio de Railway.
- Logs en directo por WebSocket (y guardados en `/data/logs`).
- Terminal real (PTY), explorador de archivos, **Monaco**, editor hexadecimal, desensamblador (`objdump`), monitor del servidor.
- Vista previa web: los proyectos con puerto se sirven en `/p/<id>/` (con login, o públicos si lo activas en Ajustes).
- Secretos cifrados (AES-256-GCM), nunca se muestran completos; cookie de sesión HttpOnly; límite de intentos de login.

## Límites honestos
- No se pudo probar contra Railway ni Discord reales desde donde se generó: haz un primer deploy y revisa los logs.
- Aislamiento por usuario Linux, no por VM: suficiente para tus propios proyectos, no para código de desconocidos.
- Los apps web bajo `/p/<id>/` deben usar rutas relativas. Solo se expone un puerto público (el del panel).
- "Conectado a Discord" se deduce de los logs del bot. El plan de Railway limita RAM/CPU totales.
- Aún no incluye: multiusuario, tareas programadas (cron), emulación de x86/ARM/RISC-V ni compilación a WebAssembly/Verilog/COBOL; los adaptadores de Telegram/Slack/Twitch/Minecraft se ejecutan como proyectos normales.
