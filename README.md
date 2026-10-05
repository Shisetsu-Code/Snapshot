# Snapshot

Automatiza capturas de 25 juegos DEMO del catálogo oficial de Pragmatic Play.

## Salida

- `snapshots/01-*.jpg` … `snapshots/25-*.jpg`
- JPEG con calidad 65
- viewport objetivo: 1280×720
- `snapshots/index.json` con título, archivo, URL de demo y fecha

El workflow se ejecuta al modificar el capturador y también puede lanzarse manualmente desde GitHub Actions.

## Ejecución local

```bash
npm install
npx playwright install chromium
npm run capture
```

El capturador:
1. abre `https://www.pragmaticplay.fun/en/slots/`;
2. acepta la confirmación 18+ y cookies si aparecen;
3. recorre botones `Play Demo`;
4. evita títulos duplicados y continúa ante fallos hasta obtener 25 capturas;
5. espera la carga del juego y cierra únicamente diálogos obvios de entrada;
6. captura el iframe de juego cuando existe, o el viewport del demo como fallback.
