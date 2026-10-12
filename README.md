# El Carterox

App web para carteros: arma la ruta de reparto con Google Maps, guarda fotos de la primera y última carta de cada calle, lee direcciones de certificadas con la cámara, lleva el registro de la jornada y da un informe semanal con meta de 5000 simples.

App independiente, sin relación con ninguna empresa de correo.

## Archivos

| Archivo | Para qué |
|---|---|
| `index.html` | Pantallas de la app |
| `styles.css` | Colores y diseño |
| `app.js` | Toda la lógica |
| `manifest.json` + `icon.svg` | Para instalarla en el celular como app |
| `sw.js` | Para que abra aunque no haya señal |

## 1. Subirla a GitHub Pages (desde el celular)

1. Entrá a github.com y creá un repositorio nuevo, por ejemplo `carterox`, **público**.
2. Tocá **Add file → Upload files** y subí los 6 archivos de arriba (más este README si querés).
3. Tocá **Commit changes**.
4. Andá a **Settings → Pages**. En *Branch* elegí `main` y la carpeta `/ (root)`. Guardá.
5. En un minuto o dos la app queda en `https://TU-USUARIO.github.io/carterox/`.
6. Abrila en el celular y, desde el menú del navegador, elegí **Agregar a pantalla de inicio**.

## 2. Sacar la clave de Google Maps

Sin clave la app funciona igual (registro, informe, ruta con tiempos aproximados), pero no detecta el lado par/impar, no muestra el mapa ni calcula traslados reales.

1. Entrá a https://console.cloud.google.com y creá un proyecto.
2. Activá la facturación (Google pide una tarjeta, pero tiene un uso mensual gratis que para una sola persona suele alcanzar; revisá los precios vigentes en la consola).
3. En **APIs y servicios → Biblioteca**, habilitá estas tres:
   - **Maps JavaScript API** (el mapa)
   - **Geocoding API** (ubicar las direcciones)
   - **Routes API** (calcular la ruta y el tiempo de traslado)
4. En **APIs y servicios → Credenciales → Crear credenciales → Clave de API**.
5. **Importante — protegé la clave:** editala y en *Restricciones de aplicación* elegí **Sitios web (referentes HTTP)** y agregá `https://TU-USUARIO.github.io/*`. En *Restricciones de API* marcá solo las tres APIs de arriba. Así nadie más puede gastar tu cuota aunque vea la clave.
6. Pegá la clave en la app: en la bienvenida o en **Ajustes**.

La clave queda guardada solo en tu teléfono, no en GitHub.

## Cómo funciona

**Cartas simples.** Cargás calle, desde y hasta (ej. Pueyrredón 51 → 720). La app busca la calle en el mapa y compara dónde caen los números pares e impares para saber de qué lado quedan los pares al subir la numeración. Con eso y tu mano (zurdo: casas a la izquierda al subir; derecho: casas a la derecha) te sugiere por qué lado subir. Si el mapa no lo puede detectar, zurdo sube por par y derecho sube por impar. Siempre podés elegir el otro lado o cambiarlo después con «⇅ Lado».
Cada dirección del tramo suma entre 2 y 3 segundos al azar. Por cada lado hay dos lugares para foto: primera y última carta.

**Certi / Doc / Telegrama.** Tocás «Escanear carta», sacás foto de la dirección y la app la lee (la primera vez descarga el lector, tarda un poco más). La registra, la ubica en el mapa y reordena la lista desde donde estás. Cada dirección suma 3 minutos. Si la lectura sale mal, tocá ✏️ para corregirla.

**Registro.** Todo manual: horarios del día, simples y certi sacadas y repartidas. Las no repartidas se calculan solas.

**Informe.** Semana de lunes a domingo, total de simples repartidas contra la meta (5000 por defecto, se cambia en Ajustes), cuántas te faltan por día, y el resumen de certificadas y horas.

**Datos.** Todo queda guardado en el teléfono. En Ajustes podés exportar una copia de seguridad (las fotos no se incluyen).
