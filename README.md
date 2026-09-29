# Editor de mapas Dofus 1.x

Editor web de mapas para servidores de Dofus 1.29 / Retro (probado con clientes 1.43.7). Lee y escribe el
formato de mapa del cliente (portado de `ank.battlefield`), dibuja con los sprites reales y funciona con o sin
base de datos.

## Funciones

- **Ver** mapas con su decorado, alturas y pendientes, con el mismo orden de capas que el cliente.
- **Seleccionar**: clic sobre un sprite (detección por píxel) para ver a qué celda y capa pertenece; `Supr` lo borra, `F` lo voltea.
- **Decorado**: pintar suelo, objeto 1 y objeto 2 desde una paleta con buscador.
- **Celdas**: caminable, línea de visión y altura (`Alt`+clic).
- **Combate**: casillas de colocación de cada equipo.
- **NPC**: colocar plantillas de NPC.
- **Nuevo** mapa desde cero y **Generar variante**: rehace el interior aprendiendo suelos, decoración y
  obstáculos de los mapas de la misma zona, sin bloquear salidas ni celdas con acción.
- **Archivos `.dmap.json`** para compartir mapas.

## Requisitos

- Node.js 18+
- Para los sprites: el cliente de Dofus Retro y [FFDec (JPEXS)](https://github.com/jindrapetrik/jpexs-decompiler) portable.
- Opcional: MariaDB/MySQL con la base de juego de un emulador (tablas `maps`, `npcs`, `npc_template`,
  `scripted_cells` y, si existe, `dream_dungeon_maps`).

## Puesta en marcha

```bash
npm install
# 1) extraer los sprites del cliente (una vez; unos minutos)
FFDEC=/ruta/ffdec-cli.jar node extract-assets.js "<cliente>/resources/app/retroclient/clips/gfx" assets
# 2) arrancar
node server.js        # http://localhost:4600
```

Con base de datos accesible en `127.0.0.1:3306` (usuario `root`, base `aegnor_game`) trabaja contra ella y
"Guardar en servidor" escribe casillas de combate y NPC. Sin base de datos (o con `OFFLINE=1`) usa
`data/maps-pack.json`.

## Paquete sin conexión

`node pack.js [salida]` vuelca todos los mapas a `data/maps-pack.json` y genera `EditorMapas.zip` con el editor,
los sprites y `node.exe`: se descomprime y se abre con doble clic en `Abrir editor.bat`, sin instalar nada.

## Aviso

Los sprites y mapas pertenecen a Ankama y **no se incluyen en este repositorio** (`assets/` y `data/` están en
`.gitignore`). Cada usuario los extrae de su propio cliente. El paquete generado por `pack.js` es para uso privado.

## Pendiente

- Exportar tiles y celdas caminables al SWF del mapa del cliente (hoy solo se guardan en servidor las casillas de combate y los NPC).
- Imagen de fondo del mapa.
