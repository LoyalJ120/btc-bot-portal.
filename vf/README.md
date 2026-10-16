# BTC Bot Portal — VF de revisión

Versión subida a una rama separada para revisión. No modifica la rama principal ni la web actualmente publicada.

Incluye pestañas funcionales: Dashboard, Operaciones, Señales, Estrategia y Configuración. No incluye gráfica. La interfaz usa datos demo hasta conectar la fuente de mercado. El historial requiere PostgreSQL. Esta versión NO ejecuta órdenes reales y todavía no es un bot autónomo 24/7. Antes de desplegar en público falta autenticación y prueba integral.

## Requisitos
Node.js 20+ y PostgreSQL.

## Inicio
1. `npm install`
2. Configura `DATABASE_URL` en las variables de entorno.
3. Ejecuta `psql "$DATABASE_URL" -f schema.sql`
4. `npm start`
5. Abre `http://localhost:3000`