# Estado del Proyecto — Cartera de Préstamos

> Documento vivo. Se actualiza al finalizar cada iteración importante.
> Última revisión: **2026-04-16** — Refactor arquitectónico a `/desktop` + `/backend`.

---

## 1. Versión y estado general

- **Versión local (en `package.json`):** `1.7.5`
- **Última release publicada en GitHub:** `1.7.5` (puede quedar adelantada la local tras nuevos cambios)
- **Estado:** App funcional y estable en Windows y Mac.
- **Repositorio:** `xJp-P/cartera-prestamos`

---

## 2. Arquitectura actual

Separación en 3 capas después del refactor:

| Capa | Carpeta | Archivo(s) | Responsabilidad |
|---|---|---|---|
| Nativa / Escritorio | `/desktop` | `main.js`, `preload.js` | Electron: ventana, IPC, auto-update, generación de PDFs |
| Datos / API | `/backend` | `server.js` | Express + SQLite + motor financiero + lógica de negocio |
| Presentación | `/public` | `index.html` | React 18 UMD (un solo archivo, sin build step) |

`desktop/main.js` arranca el servidor Express de `backend/server.js` en `127.0.0.1:3420` y carga la ventana contra `http://127.0.0.1:3420`.

Archivos de apoyo:
- `package.json` — configuración de build (electron-builder) + dependencias.
- `.github/workflows/build.yml` — CI que compila instaladores y publica release en GitHub.
- `build/` — iconos y script NSIS del desinstalador.
- `prefs.json` — preferencias del usuario (ruta alterna de BD, etc.). Se genera en runtime.
- `cartera.db` — base de datos SQLite. Solo existe en desarrollo en la raíz; en prod vive en `userData`.

---

## 3. Limpieza aplicada en este ciclo

Código muerto eliminado:

1. `desktop/main.js` — se removió `shell` del destructuring de `require('electron')` (importado pero nunca usado).
2. `backend/server.js` — se removió `const prevAbonos` en `/api/recalculate` (declarado pero nunca referenciado).
3. `backend/server.js` — se removió `const hoy = hoyStr()` al inicio de `autoExtendSoloIntereses` (no usado).
4. `backend/server.js` — se removió `const pendientes = regulares.filter(...)` en `autoExtendSoloIntereses` (no usado).

Comprobaciones adicionales:
- **console.log/warn/debug/info:** no había ninguno en `main.js`, `preload.js`, `server.js` ni `public/index.html`.
- **Imports huérfanos:** solo `shell`. El resto de requires se usa.

---

## 4. Funcionalidades principales en producción

### Gestión de préstamos
- Modalidades: `Intereses` (plazo ∞), `Capital + Intereses` (amortización francesa), `Prestamo` (0% interés, una cuota).
- Frecuencias: Mensual, Quincenal, Semanal (conversión de tasa automática).
- Moneda: COP y USD con TRM acordada por préstamo.

### Vistas (8)
1. Inicio (Dashboard con KPIs + secciones por vencimiento)
2. Cartera (Activos/Finalizados + cronograma expandible)
3. Deudores (Perfiles con historial de créditos)
4. Pagos (Pendientes/Mora + toggle pagados)
5. Rendimiento (KPIs globales + tabs Activo/Cancelado)
6. Calculadora (simulador que confirma → crea préstamo)
7. Historial (log de acciones)
8. Desarrollador (ruta de BD, info del sistema, updates, sincronizar)

### Lógicas automáticas clave
- **Auto-mora:** cuotas vencidas con `estadoPago='Pendiente'` → `'En Mora'` al arrancar y en cada `GET /api/payments`.
- **Auto-finalización:** todas las cuotas regulares `'Pagado'` → `loan.estado='Cancelado'`.
- **Auto-extend (Intereses):** si quedan < 3 cuotas pendientes futuras, se generan 3 más automáticamente.
- **Auto-link deudores:** al crear préstamo, consolida por nombre (case-insensitive).
- **Fix cuotas mora Préstamo:** `cuotaTotal` de mora se ajusta al `montoCOP` actual tras abonos.

### PDFs
- **Recibo de pago:** al marcar cuota como pagada.
- **Cronograma:** desde DebtorModal. Tema-aware (usa tema claro/oscuro activo).

### Auto-update
- **Windows:** `electron-updater` estándar.
- **Mac:** Custom updater (descarga ZIP de GitHub Releases, `xattr -cr`, reemplaza app). No requiere firma de Apple.

---

## 5. Tareas pendientes / ideas en backlog

### Infraestructura
- [ ] **Optimizar `extraResources` en `package.json`:** actualmente duplica archivos. Se puede limpiar para no enviar `desktop/` + `backend/` + `public/` dos veces (una vez en asar, otra suelta).
- [ ] **Dividir `public/index.html`:** con ~2500+ líneas, empieza a ser costoso en tokens. Posibles paths:
  - Extraer `styles.css` a archivo aparte.
  - Extraer componentes grandes (DebtorModal, LoanModal, PayModal, AbonoModal, Dashboard) a JS separados y cargarlos con `<script>` (sin build step).
  - Alternativa más ambiciosa: introducir esbuild/Vite y migrar a JSX.
- [ ] **Separar rutas del backend en archivos temáticos:** hoy todo está dentro del factory `createApp()`. Podría separarse en `backend/routes/loans.js`, `backend/routes/payments.js`, `backend/routes/config.js`, etc., y mantener `backend/db.js` con la inicialización del schema.

### UX / Funcional
- [ ] **Versión móvil iOS vía 3uTools:** pendiente de investigación. La base Electron no corre en iOS, requeriría migración a Capacitor o acceso al backend local vía Safari en LAN.
- [ ] **Notificaciones de vencimientos:** hoy solo se ven al abrir la app. Podría agregarse notification system nativo (Electron `Notification` API).
- [ ] **Backup automático de la BD:** actualmente el usuario debe respaldar manualmente `cartera.db`. Se podría programar un snapshot diario a una carpeta configurable.
- [ ] **Exportar reporte financiero:** un PDF mensual con recaudo, mora y proyección.

### Técnico
- [ ] **Migrar auto-extend a un cron en el proceso Electron:** hoy se dispara en cada `GET /api/payments`. Funciona bien pero ensucia la lectura.
- [ ] **Firma de código para Mac:** si se llega a pagar Apple Developer ($99/año), reemplazar el custom updater por Squirrel.Mac para actualizaciones silenciosas.

---

## 6. Bugs conocidos

Ninguno abierto en este momento. Historial de bugs cerrados está en `CLAUDE.md` sección "Bugs Corregidos".

---

## 7. Notas para futuras sesiones

- El código está optimizado para bajo consumo de tokens: `/backend` y `/desktop` son pequeños y autocontenidos; la mayor parte del contexto pesado vive en `public/index.html`.
- `.claudesignore` excluye `node_modules`, `dist`, `.git`, `build`, `.github`, DB, y archivos binarios.
- En refactors futuros **no tocar**: fórmula de saldo (`montoOrigen - todoCapPagado`), separación abonos vs. cuotas regulares (filtro `id.indexOf('-ab-')`), `pendingDelete` mechanism al mover BD.
