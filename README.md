# BTC Bot Portal

Panel estático de señales experimentales de BTC en velas de 15 minutos. Consulta velas públicas de Hyperliquid y calcula EMA20, EMA50 y RSI14 en el navegador.

## Publicar

El workflow `.github/workflows/pages.yml` publica el sitio mediante GitHub Pages al hacer push. En el repositorio abre **Settings → Pages** y, si se solicita, selecciona **GitHub Actions** como fuente de publicación. Después abre la pestaña **Actions** para ver el despliegue y el enlace del sitio.

## Seguridad y limitaciones

No se conecta a una wallet, no solicita ni guarda claves y no ejecuta órdenes. Las señales son experimentales y no garantizan rentabilidad. La página requiere que el navegador pueda consultar la API pública de Hyperliquid; si CORS bloquea la petición, habrá que implementar un proxy seguro.
